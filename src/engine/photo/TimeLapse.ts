import {
  BufferTarget,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
  StreamTarget,
  VideoSample,
  VideoSampleSource,
  getFirstEncodableVideoCodec,
  type StreamTargetChunk,
} from 'mediabunny';
import type { World } from '../world/World';
import type { PhotoMode } from './PhotoMode';
import { cameraAt, planTimelapse, type Keyframe, type Span } from '../../photo/timelapse';
import type { Resolution } from '../../photo/lens';

export interface TimeLapseOptions {
  span: Span;
  /** Simulated seconds between frames. */
  interval: number;
  /** The camera: one keyframe for a fixed camera, 2–5 for a path. */
  keyframes: Keyframe[];
  resolution: Resolution;
  /** Frames averaged per video frame (light accumulation: smooth edges). */
  samples: number;
  fps?: number;
}

export interface TimeLapseProgress {
  frame: number;
  frames: number;
}

/**
 * Records a time-lapse (plan 6.10): the clock jumps to each frame's exact moment (so recording never changes the
 * simulation: the ecosystem runs in its own fixed steps), the world updates, the camera moves along its path, each
 * frame is lightly accumulated, encoded by WebCodecs (the GPU's hardware encoder when it has one) and muxed by
 * Mediabunny into an MP4 streamed straight to the file, so long captures don't fill memory. Without a file stream
 * (`writable` null) the MP4 is kept in memory and returned as a Blob.
 */
export async function recordTimeLapse(
  world: World,
  photo: PhotoMode,
  options: TimeLapseOptions,
  writable: WritableStream<StreamTargetChunk> | null,
  onProgress: (p: TimeLapseProgress) => void,
): Promise<Blob | null> {
  const fps = options.fps ?? 30;
  const plan = planTimelapse(world.clock.seconds, options.span, options.interval, fps);
  const [width, height] = photo.outputSize(options.resolution === 'screen' ? '1080p' : options.resolution);
  // H.264 first (plays everywhere), then the others MP4 can hold.
  const codec = await getFirstEncodableVideoCodec(['avc', 'hevc', 'vp9', 'av1'], { width, height });
  if (!codec) throw new Error("This browser can't encode video at that size");
  const target = writable ? new StreamTarget(writable, { chunked: true }) : new BufferTarget();
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: writable ? false : 'in-memory' }), target });
  const source = new VideoSampleSource({ codec, quality: QUALITY_HIGH, keyFrameInterval: 2 });
  output.addVideoTrack(source, { frameRate: fps });
  await output.start();

  const clock = world.clock;
  const saved = {
    paused: clock.paused,
    position: photo.position.clone(),
    yaw: photo.yaw,
    pitch: photo.pitch,
    focal: photo.settings.focalLength,
  };
  const camera = world.engine.camera;
  let done = false;
  try {
    await photo.withCaptureSetup(width, height, async (render, acc) => {
      clock.paused = true;
      world.capturing = true;
      let time = world.engine.time;
      for (let f = 0; f < plan.frameTimes.length; f++) {
        if (photo.isCancelled) return;
        clock.seconds = plan.frameTimes[f] as number;
        // The ecosystem catches up to this moment in its own fixed steps (weather, the stream, the fish).
        await world.ecology.syncNow();
        const key = cameraAt(options.keyframes, plan.frameTimes.length > 1 ? f / (plan.frameTimes.length - 1) : 0);
        time += 1 / fps;
        world.update({ dt: 1 / fps, time, frame: f });
        camera.position.set(key.x, key.y, key.z);
        camera.rotation.set(key.pitch, key.yaw, 0, 'YXZ');
        camera.fov = key.fov;
        camera.updateProjectionMatrix();
        camera.updateMatrixWorld();
        await photo.accumulate(render, acc, Math.max(1, options.samples), { lens: false, show: true });
        const pixels = await acc.read();
        const sample = new VideoSample(pixels, {
          format: 'RGBA',
          codedWidth: width,
          codedHeight: height,
          timestamp: f / fps,
          duration: 1 / fps,
        });
        await source.add(sample);
        sample.close();
        photo.progress = (f + 1) / plan.frameTimes.length;
        onProgress({ frame: f + 1, frames: plan.frameTimes.length });
      }
      done = true;
    });
  } finally {
    // The valley stays where the recording left it: it has lived through the span.
    world.capturing = false;
    clock.paused = saved.paused;
    photo.position.copy(saved.position);
    photo.yaw = saved.yaw;
    photo.pitch = saved.pitch;
    photo.settings.focalLength = saved.focal;
    if (!done) await output.cancel();
  }
  await output.finalize();
  if (target instanceof BufferTarget && target.buffer) return new Blob([target.buffer], { type: 'video/mp4' });
  return null;
}
