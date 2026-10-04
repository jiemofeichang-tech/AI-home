export const MAX_VIDEO_BYTES=50*1024*1024;
export const VIDEO_MIMES=['video/mp4','video/webm'] as const;
export type VideoMime=typeof VIDEO_MIMES[number];
export function isVideoMime(value:unknown):value is VideoMime {
  return value==='video/mp4'||value==='video/webm';
}
