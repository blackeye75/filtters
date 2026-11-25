#!/usr/bin/env python3
"""
Generates the shared face assets used by every platform (web, Android, iOS):

  shared/face_mesh.json         468 UVs (top-left origin), render triangles, landmark groups
  web/src/engine/faceMeshData.ts  same data as a TypeScript module
  shared/makeup_atlas.png       UV-space masks: R = lips, G = blush, B = skin (A = 255)
  shared/uv_template.png        wireframe of the UV layout, for designers painting custom masks

Source: MediaPipe canonical_face_model.obj (Apache 2.0), vertex i == landmark i.

Usage:  python3 tools/gen_face_assets.py
"""
import json
import math
import os

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OBJ = os.path.join(HERE, "canonical_face_model.obj")
ATLAS = 1024

# ---------------------------------------------------------------- landmark groups (MediaPipe indices)
LIPS_OUTER = [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0, 37, 39, 40, 185]
LIPS_INNER = [78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308, 415, 310, 311, 312, 13, 82, 81, 80, 191]
RIGHT_EYE = [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246]
LEFT_EYE = [263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466]
RIGHT_BROW = [46, 53, 52, 65, 55, 107, 66, 105, 63, 70]
LEFT_BROW = [276, 283, 282, 295, 285, 336, 296, 334, 293, 300]
FACE_OVAL = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377,
             152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109]
# Points used at runtime
CHEEK_SAMPLE = [205, 425]        # skin colour reference for lip-edge refinement
LOWER_LIP_BODY = [17, 14]        # midpoint = lip colour reference
EYE_CORNERS = [33, 263]          # inter-ocular distance for face-unit smoothing
STABLE_POINTS = [6, 197, 195, 5, 4, 1, 168, 8, 9, 151, 234, 454, 127, 356, 93, 323]  # rigid-ish (pose fit)


def load_obj(path):
    verts, uvs, faces = [], [], []
    for line in open(path):
        p = line.split()
        if not p:
            continue
        if p[0] == "v":
            verts.append(tuple(map(float, p[1:4])))
        elif p[0] == "vt":
            uvs.append(tuple(map(float, p[1:3])))
        elif p[0] == "f":
            faces.append([tuple(int(x) for x in t.split("/")[:2]) for t in p[1:]])
    uv_of = [None] * len(verts)
    tris = []
    for f in faces:
        tri = []
        for vi, ti in f:
            uv_of[vi - 1] = uvs[ti - 1]
            tri.append(vi - 1)
        tris.append(tri)
    assert all(u is not None for u in uv_of)
    return np.array(verts), np.array(uv_of), tris


def interior_tris(tris, ring):
    s = set(ring)
    return [t for t in tris if set(t) <= s]


def main():
    verts, uv, tris = load_obj(OBJ)
    assert len(verts) == 468 and len(tris) == 898

    # The canonical mesh triangulates the mouth opening and the eyes. If those triangles are
    # rendered, makeup gets painted on teeth/eyeballs when the mouth or eyes open. Drop them.
    holes = interior_tris(tris, LIPS_INNER) + interior_tris(tris, RIGHT_EYE) + interior_tris(tris, LEFT_EYE)
    hole_set = {tuple(t) for t in holes}
    render_tris = [t for t in tris if tuple(t) not in hole_set]
    print(f"triangles: {len(tris)} total, {len(holes)} removed (mouth+eyes), {len(render_tris)} rendered")

    # Top-left origin UVs (image row 0 = top), the convention of WebGL, GLES Bitmap upload and Metal.
    uv_tl = np.stack([uv[:, 0], 1.0 - uv[:, 1]], axis=1)

    def px(i):
        return (uv_tl[i, 0] * ATLAS, uv_tl[i, 1] * ATLAS)

    def poly(ring):
        return [px(i) for i in ring]

    def mask_from(draw_fn, blur):
        img = Image.new("L", (ATLAS, ATLAS), 0)
        d = ImageDraw.Draw(img)
        draw_fn(d)
        if blur > 0:
            img = img.filter(ImageFilter.GaussianBlur(blur))
        return np.asarray(img, dtype=np.float32) / 255.0

    # ---------------- lips: outer polygon, slightly dilated, soft outer edge.
    # Inner edge needs no feather here: the mouth-hole triangles are not rendered, and the
    # runtime colour refinement handles the lip/teeth boundary.
    lips = mask_from(lambda d: d.polygon(poly(LIPS_OUTER), fill=255), blur=3)
    lips = np.clip(lips * 1.25, 0, 1)  # keep the body solid, edge still soft

    # ---------------- blush: soft elliptical blobs on the cheek apples, tilted toward the temples.
    yy, xx = np.mgrid[0:ATLAS, 0:ATLAS].astype(np.float32) / ATLAS
    blush = np.zeros_like(xx)
    # centres picked between landmarks 50 / 101 / 117 (and mirrors), in top-left UV
    for side in (-1, 1):
        cx = 0.5 + side * 0.212
        cy = 1.0 - 0.497
        ang = math.radians(-18 * side)  # tilt up toward the temple
        dx, dy = xx - cx, yy - cy
        rx = dx * math.cos(ang) - dy * math.sin(ang)
        ry = dx * math.sin(ang) + dy * math.cos(ang)
        d2 = (rx / 0.100) ** 2 + (ry / 0.064) ** 2
        blush = np.maximum(blush, np.exp(-d2 * 1.25))
    # never put blush on the eye area or the nose
    eye_guard = mask_from(lambda d: (d.polygon(poly(RIGHT_EYE), fill=255), d.polygon(poly(LEFT_EYE), fill=255)), blur=0)
    eye_guard = np.asarray(Image.fromarray((eye_guard * 255).astype(np.uint8)).filter(ImageFilter.MaxFilter(41)).filter(ImageFilter.GaussianBlur(14)), dtype=np.float32) / 255
    blush *= 1.0 - eye_guard

    # ---------------- skin: face area minus eyes, brows, lips; faded at the face border.
    def skin_draw(d):
        d.polygon(poly(FACE_OVAL), fill=255)
    skin = mask_from(skin_draw, blur=0)
    skin_img = Image.fromarray((skin * 255).astype(np.uint8)).filter(ImageFilter.MinFilter(31)).filter(ImageFilter.GaussianBlur(18))
    skin = np.asarray(skin_img, dtype=np.float32) / 255

    def holes_draw(d):
        for ring in (RIGHT_EYE, LEFT_EYE, RIGHT_BROW, LEFT_BROW, LIPS_OUTER):
            d.polygon(poly(ring), fill=255)
    cut = mask_from(holes_draw, blur=0)
    cut_img = Image.fromarray((cut * 255).astype(np.uint8)).filter(ImageFilter.MaxFilter(17)).filter(ImageFilter.GaussianBlur(8))
    cut = np.asarray(cut_img, dtype=np.float32) / 255
    skin = np.clip(skin * (1.0 - cut), 0, 1)

    atlas = np.zeros((ATLAS, ATLAS, 4), dtype=np.uint8)
    atlas[..., 0] = (lips * 255 + 0.5).astype(np.uint8)
    atlas[..., 1] = (blush * 255 + 0.5).astype(np.uint8)
    atlas[..., 2] = (skin * 255 + 0.5).astype(np.uint8)
    atlas[..., 3] = 255
    os.makedirs(os.path.join(ROOT, "shared"), exist_ok=True)
    Image.fromarray(atlas, "RGBA").save(os.path.join(ROOT, "shared", "makeup_atlas.png"), optimize=True)

    # ---------------- designer template: wireframe + region outlines
    tpl = Image.new("RGB", (ATLAS, ATLAS), (250, 250, 250))
    d = ImageDraw.Draw(tpl)
    for t in render_tris:
        p = [px(i) for i in t]
        d.line(p + [p[0]], fill=(185, 185, 185), width=1)
    for ring, col in ((LIPS_OUTER, (200, 30, 60)), (LIPS_INNER, (200, 30, 60)), (RIGHT_EYE, (30, 90, 200)),
                      (LEFT_EYE, (30, 90, 200)), (RIGHT_BROW, (90, 60, 20)), (LEFT_BROW, (90, 60, 20)),
                      (FACE_OVAL, (40, 40, 40))):
        p = poly(ring)
        d.line(p + [p[0]], fill=col, width=2)
    tpl.save(os.path.join(ROOT, "shared", "uv_template.png"), optimize=True)

    # ---------------- preview for review: atlas over template
    prev = np.asarray(tpl, dtype=np.float32) / 255
    over = prev.copy()
    over = over * (1 - lips[..., None] * 0.8) + np.array([0.85, 0.1, 0.3]) * lips[..., None] * 0.8
    over = over * (1 - blush[..., None] * 0.6) + np.array([1.0, 0.45, 0.55]) * blush[..., None] * 0.6
    over = over * (1 - skin[..., None] * 0.25) + np.array([0.2, 0.7, 0.3]) * skin[..., None] * 0.25
    Image.fromarray((np.clip(over, 0, 1) * 255).astype(np.uint8)).save(os.path.join(HERE, "atlas_preview.png"))

    # ---------------- mesh data
    data = {
        "source": "MediaPipe canonical_face_model.obj (Apache-2.0); vertex i == landmark i",
        "uvOrigin": "top-left",
        "uv": [round(float(x), 6) for x in uv_tl.reshape(-1)],
        "triangles": [i for t in render_tris for i in t],
        "groups": {
            "lipsOuter": LIPS_OUTER, "lipsInner": LIPS_INNER,
            "rightEye": RIGHT_EYE, "leftEye": LEFT_EYE,
            "rightBrow": RIGHT_BROW, "leftBrow": LEFT_BROW,
            "faceOval": FACE_OVAL, "cheekSample": CHEEK_SAMPLE,
            "lowerLipBody": LOWER_LIP_BODY, "eyeCorners": EYE_CORNERS,
            "stablePoints": STABLE_POINTS,
        },
    }
    with open(os.path.join(ROOT, "shared", "face_mesh.json"), "w") as f:
        json.dump(data, f, separators=(",", ":"))

    lip_set = sorted(set(LIPS_OUTER) | set(LIPS_INNER))
    ts = os.path.join(ROOT, "web", "src", "engine", "faceMeshData.ts")
    os.makedirs(os.path.dirname(ts), exist_ok=True)
    with open(ts, "w") as f:
        f.write("// GENERATED by tools/gen_face_assets.py. Do not edit by hand.\n")
        f.write("// Source: MediaPipe canonical_face_model.obj (Apache-2.0). Vertex i == landmark i.\n\n")
        f.write("/** 468 UVs, top-left origin, interleaved u,v. */\n")
        f.write(f"export const FACE_UV = new Float32Array({json.dumps(data['uv'], separators=(',', ':'))});\n\n")
        f.write(f"/** {len(render_tris)} triangles (mouth and eye interiors removed). */\n")
        f.write(f"export const FACE_TRIANGLES = new Uint16Array({json.dumps(data['triangles'], separators=(',', ':'))});\n\n")
        f.write("export const GROUPS = " + json.dumps(data["groups"], separators=(",", ":")) + " as const;\n\n")
        f.write("/** Landmarks that move with speech; smoothed with a higher cutoff. */\n")
        f.write(f"export const LIP_LANDMARKS = {json.dumps(lip_set, separators=(',', ':'))};\n")
    print("wrote shared/face_mesh.json, shared/makeup_atlas.png, shared/uv_template.png, web/src/engine/faceMeshData.ts")


if __name__ == "__main__":
    main()
