// How the filter plugs into an existing react-native-webrtc call. Nothing else in the call changes:
// the processor runs inside the camera capture path, so RTCView (local preview) and the remote peer
// both receive the already-filtered frames.
import React, { useEffect, useRef, useState } from "react";
import { Button, View } from "react-native";
import { mediaDevices, RTCPeerConnection, RTCView, MediaStream } from "react-native-webrtc";
import { attachFaceFilter, applyPreset, setFilterParams, setFilterEnabled, getFilterStats, hex } from "face-filter";

export function CallScreen({ pc }: { pc: RTCPeerConnection }) {
  const [local, setLocal] = useState<MediaStream | null>(null);
  const [beauty, setBeauty] = useState(true);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    (async () => {
      const stream = await mediaDevices.getUserMedia({
        audio: true,
        video: { facingMode: "user", width: 1280, height: 720, frameRate: 30 },
      });
      const video = stream.getVideoTracks()[0];
      attachFaceFilter(video);          // before or after addTrack, both work
      applyPreset("Rose");
      stream.getTracks().forEach((t) => pc.addTrack(t, stream));
      setLocal(stream);
    })();
  }, [pc]);

  // Optional: surface processing cost in a debug overlay
  useEffect(() => {
    const id = setInterval(() => console.log("filter", getFilterStats()), 5000);
    return () => clearInterval(id);
  }, []);

  return (
    <View style={{ flex: 1 }}>
      {local && <RTCView streamURL={local.toURL()} mirror objectFit="cover" style={{ flex: 1 }} />}
      <Button title={beauty ? "Beauty: on" : "Beauty: off"} onPress={() => { setFilterEnabled(!beauty); setBeauty(!beauty); }} />
      <Button title="Berry" onPress={() => applyPreset("Berry")} />
      <Button title="Custom coral, glossy" onPress={() => setFilterParams({ lips: { color: hex("#e2574c"), gloss: 0.6 } })} />
    </View>
  );
}
