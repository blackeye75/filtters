#!/usr/bin/env python3
"""
Renders synthetic test faces from the canonical mesh (no camera or model needed) plus their exact
landmarks, so the GPU pipeline can be tested headlessly:
  frontal (mouth closed), yaw 30 deg (far-cheek occlusion), mouth open (teeth must stay unpainted).
Output: test/fixtures/<name>.png + <name>.json  (landmarks in MediaPipe convention: x,y 0..1, z ~ x scale)
"""
import json, math, os
import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
KIT = os.path.dirname(os.path.dirname(HERE))
OBJ = os.path.join(KIT, "tools", "canonical_face_model.obj")
OUT = os.path.join(HERE, "fixtures")
W, H = 1280, 720
MESH = json.load(open(os.path.join(KIT, "shared", "face_mesh.json")))
ATLAS = np.asarray(Image.open(os.path.join(KIT, "shared", "makeup_atlas.png")), dtype=np.float32) / 255

def load():
    V, VT, F = [], [], []
    for line in open(OBJ):
        p = line.split()
        if not p: continue
        if p[0] == "v": V.append(list(map(float, p[1:4])))
        elif p[0] == "f": F.append([int(t.split("/")[0]) - 1 for t in p[1:]])
    return np.array(V), np.array(F)

def render(name, yaw_deg=0.0, mouth_open=0.0):
    V, F = load()
    V = V.copy()
    uv = np.array(MESH["uv"]).reshape(-1, 2)
    inner_lower = [95, 88, 178, 87, 14, 317, 402, 318, 324]
    if mouth_open > 0:  # drop the jaw: everything below the mouth line moves down, fading out sideways
        y0 = V[13, 1]
        for i in range(len(V)):
            if V[i, 1] < y0 - 0.05 or i in inner_lower:
                w = math.exp(-(V[i, 0] / 4.5) ** 4)
                V[i, 1] -= mouth_open * w
    a = math.radians(yaw_deg)
    R = np.array([[math.cos(a), 0, math.sin(a)], [0, 1, 0], [-math.sin(a), 0, math.cos(a)]])
    P = V @ R.T
    s = 22.0  # px per cm
    sx = W / 2 + P[:, 0] * s
    sy = H / 2 + 20 - P[:, 1] * s
    depth = P[:, 2]

    # vertex normals for shading
    N = np.zeros_like(P)
    for f in F:
        n = np.cross(P[f[1]] - P[f[0]], P[f[2]] - P[f[0]])
        N[f] += n
    N /= np.linalg.norm(N, axis=1, keepdims=True) + 1e-9
    if N[1, 2] < 0: N = -N  # nose normal toward camera
    light = np.array([0.35, 0.45, 0.82]); light /= np.linalg.norm(light)

    yy, xx = np.mgrid[0:H, 0:W]
    img = np.zeros((H, W, 3), np.float32)
    img[:] = (np.linspace(0.18, 0.3, H)[:, None, None]) * np.array([1.0, 1.0, 1.05])
    zbuf = np.full((H, W), -1e9, np.float32)
    rng = np.random.default_rng(3)
    noise = rng.normal(0, 1, (H, W)).astype(np.float32)
    skin = np.array([0.86, 0.66, 0.55]); lipc = np.array([0.74, 0.43, 0.44])
    mouth_tris = {tuple(sorted(t)) for t in F.tolist() if set(t) <= set(MESH["groups"]["lipsInner"])}

    for f in F:
        x0, x1 = int(max(min(sx[f]), 0)), int(min(max(sx[f]) + 1, W))
        y0, y1 = int(max(min(sy[f]), 0)), int(min(max(sy[f]) + 1, H))
        if x1 <= x0 or y1 <= y0: continue
        X, Y = xx[y0:y1, x0:x1] + 0.5, yy[y0:y1, x0:x1] + 0.5
        (ax, ay), (bx, by), (cx, cy) = [(sx[i], sy[i]) for i in f]
        den = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy)
        if abs(den) < 1e-9: continue
        l0 = ((by - cy) * (X - cx) + (cx - bx) * (Y - cy)) / den
        l1 = ((cy - ay) * (X - cx) + (ax - cx) * (Y - cy)) / den
        l2 = 1 - l0 - l1
        inside = (l0 >= 0) & (l1 >= 0) & (l2 >= 0)
        z = l0 * depth[f[0]] + l1 * depth[f[1]] + l2 * depth[f[2]]
        zb = zbuf[y0:y1, x0:x1]
        m = inside & (z > zb)
        if not m.any(): continue
        zb[m] = z[m]
        n = l0[..., None] * N[f[0]] + l1[..., None] * N[f[1]] + l2[..., None] * N[f[2]]
        n /= np.linalg.norm(n, axis=-1, keepdims=True) + 1e-9
        shade = np.clip(n @ light, 0, 1) * 0.75 + 0.25
        if tuple(sorted(f)) in mouth_tris:
            col = np.where((Y - (sy[13] + 4) < 7)[..., None] & (mouth_open > 0), np.array([0.92, 0.9, 0.86]), np.array([0.18, 0.05, 0.06]))
            col = col * np.ones_like(shade)[..., None]
        else:
            u = l0 * uv[f[0], 0] + l1 * uv[f[1], 0] + l2 * uv[f[2], 0]
            v = l0 * uv[f[0], 1] + l1 * uv[f[1], 1] + l2 * uv[f[2], 1]
            lipw = ATLAS[np.clip((v * 1023).astype(int), 0, 1023), np.clip((u * 1023).astype(int), 0, 1023), 0]
            lipw = np.clip((lipw - 0.35) / 0.5, 0, 1)
            lines = 0.92 + 0.08 * np.sin(u * 900)        # vertical lip lines
            base = skin[None, None] * (1 - lipw[..., None]) + (lipc * lines[..., None]) * lipw[..., None]
            col = base * shade[..., None]
        tile = img[y0:y1, x0:x1]
        tile[m] = col[m]
    img += noise[..., None] * 0.012
    os.makedirs(OUT, exist_ok=True)
    Image.fromarray((np.clip(img, 0, 1) ** (1 / 1.0) * 255).astype(np.uint8)).save(os.path.join(OUT, f"{name}.png"))
    zmp = -(depth - depth.mean()) * s / W
    lm = [[float(sx[i] / W), float(sy[i] / H), float(zmp[i])] for i in range(468)]
    json.dump({"width": W, "height": H, "landmarks": lm}, open(os.path.join(OUT, f"{name}.json"), "w"))
    print("wrote", name)

if __name__ == "__main__":
    render("frontal")
    render("yaw30", yaw_deg=30)
    render("mouth_open", mouth_open=1.1)
