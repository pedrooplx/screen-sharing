/**
 * Codecs the SFU is willing to speak. werift picks the intersection with what
 * Chromium offers, so listing the common screen-share codecs (VP8, VP9, H264)
 * plus Opus is enough. Payload types are the de-facto Chromium defaults; werift
 * remaps as needed during negotiation.
 */

import { RTCRtpCodecParameters } from 'werift';

const VIDEO_FEEDBACK = [
  { type: 'nack' },
  { type: 'nack', parameter: 'pli' },
  { type: 'ccm', parameter: 'fir' },
  { type: 'goog-remb' },
  { type: 'transport-cc' },
];

export const VIDEO_CODECS = [
  new RTCRtpCodecParameters({
    mimeType: 'video/VP8',
    clockRate: 90000,
    rtcpFeedback: VIDEO_FEEDBACK,
    payloadType: 96,
  }),
  new RTCRtpCodecParameters({
    mimeType: 'video/VP9',
    clockRate: 90000,
    rtcpFeedback: VIDEO_FEEDBACK,
    parameters: 'profile-id=0',
    payloadType: 98,
  }),
  new RTCRtpCodecParameters({
    mimeType: 'video/H264',
    clockRate: 90000,
    rtcpFeedback: VIDEO_FEEDBACK,
    parameters:
      'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f',
    payloadType: 102,
  }),
];

export const AUDIO_CODECS = [
  new RTCRtpCodecParameters({
    mimeType: 'audio/opus',
    clockRate: 48000,
    channels: 2,
    payloadType: 111,
  }),
];
