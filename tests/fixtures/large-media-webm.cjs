'use strict';
// Offline fixture encoder/muxer. No filler, sparse extents, repeated clip or downloads.
// Every SimpleBlock contains a newly encoded canvas VP8 keyframe. Stream writes
// keep the full movie out of JS memory. WebM IDs follow webmproject.org/docs/container/.
const fs = require('node:fs');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const id = hex => Buffer.from(hex, 'hex');
function uint(value, width) {
  const count = width || Math.max(1, Math.ceil(Math.log2(value + 1) / 8));
  const bytes = Buffer.alloc(count); bytes.writeUIntBE(value, 0, count); return bytes;
}
function size(value, width = 8) {
  let n = BigInt(value) | (1n << BigInt(7 * width));
  const bytes = Buffer.alloc(width);
  for (let i = width - 1; i >= 0; i--) { bytes[i] = Number(n & 255n); n >>= 8n; }
  return bytes;
}
const element = (hex, bytes) => Buffer.concat([id(hex), size(bytes.length), bytes]);
const master = (hex, parts) => element(hex, Buffer.concat(parts));
const number = (hex, n, width) => element(hex, uint(n, width));
const text = (hex, value) => element(hex, Buffer.from(value));
function double(n) { const bytes = Buffer.alloc(8); bytes.writeDoubleBE(n); return bytes; }
module.exports = async function generate({ win, target, minimumBytes = 112 * 1024 * 1024, fps = 12, width = 960, height = 540 }) {
  const started = Date.now(), fd = fs.openSync(target, 'wx');
  let position = 0, frames = 0, encodedBytes = 0, maxFrameBytes = 0;
  const cues = [], digest = crypto.createHash('sha256');
  const append = bytes => { fs.writeSync(fd, bytes, 0, bytes.length, position); position += bytes.length; };
  const seek = offset => master('114d9b74', [master('4dbb', [element('53ab', id('1c53bb6b')), number('53ac', offset, 6)])]);
  const info = duration => master('1549a966', [number('2ad7b1', 1000000), text('4d80', 'offline-webcodecs-fixture'), text('5741', 'offline-webcodecs-fixture'), element('4489', double(duration))]);
  try {
    append(master('1a45dfa3', [number('4286', 1), number('42f7', 1), number('42f2', 4), number('42f3', 8), text('4282', 'webm'), number('4287', 4), number('4285', 2)]));
    append(id('18538067')); const sizeAt = position; append(size(0)); const segmentAt = position;
    const seekAt = position; append(seek(0)); const infoAt = position; append(info(0));
    append(master('1654ae6b', [master('ae', [number('d7', 1), number('73c5', 1), number('83', 1), number('9c', 0), text('86', 'V_VP8'), number('23e383', Math.round(1e9 / fps)), master('e0', [number('b0', width), number('ba', height)])])]));
    const config = { codec: 'vp8', width, height, bitrate: 64000000, framerate: fps, latencyMode: 'realtime', hardwareAcceleration: 'prefer-software' };
    const supported = await win.webContents.executeJavaScript(`(async()=>{const config=${JSON.stringify(config)};if(typeof VideoEncoder==='undefined')throw Error('webcodecs_unavailable');const support=await VideoEncoder.isConfigSupported(config);if(!support.supported)throw Error('vp8_unavailable');const canvas=document.createElement('canvas');canvas.width=config.width;canvas.height=config.height;const context=canvas.getContext('2d',{willReadFrequently:true});const pixels=context.createImageData(config.width,config.height);let output=null,fault=null,seed=0x12345678;const encoder=new VideoEncoder({output:chunk=>{const bytes=new Uint8Array(chunk.byteLength);chunk.copyTo(bytes);output={bytes,type:chunk.type,timestamp:chunk.timestamp}},error:e=>fault=e.name});encoder.configure(config);window.__encodeFrame=async index=>{const a=pixels.data;for(let p=0;p<a.length;p+=4){seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;a[p]=seed&255;a[p+1]=(seed>>>8)&255;a[p+2]=(seed>>>16)&255;a[p+3]=255}context.putImageData(pixels,0,0);context.fillStyle='black';context.fillRect(0,0,config.width,48);context.fillStyle='white';context.font='28px sans-serif';context.fillText('OFFLINE VP8 FRAME '+index,16,34);output=null;const frame=new VideoFrame(canvas,{timestamp:Math.round(index*1e6/config.framerate),duration:Math.round(1e6/config.framerate)});encoder.encode(frame,{keyFrame:true});frame.close();await encoder.flush();if(fault||!output)throw Error(fault||'missing_frame');let binary='';for(let i=0;i<output.bytes.length;i+=16384)binary+=String.fromCharCode(...output.bytes.subarray(i,i+16384));return {data:btoa(binary),type:output.type,timestamp:output.timestamp}};window.__closeEncoder=()=>encoder.close();return {codec:config.codec,width:config.width,height:config.height}})()`, true);
    while (encodedBytes < minimumBytes || frames < 360) {
      assert.ok(frames < 2000, 'bounded offline generation');
      const chunk = await win.webContents.executeJavaScript(`window.__encodeFrame(${frames})`, true);
      assert.equal(chunk.type, 'key', 'every fixture frame must be independently decodable');
      const bytes = Buffer.from(chunk.data, 'base64');
      assert.ok(bytes.length > 10 && (bytes[0] & 1) === 0 && bytes.subarray(3, 6).equals(Buffer.from([0x9d, 1, 0x2a])), 'actual VP8 keyframe bitstream');
      const timestamp = Math.round(chunk.timestamp / 1000), clusterAt = position - segmentAt;
      const cluster = master('1f43b675', [number('e7', timestamp), element('a3', Buffer.concat([Buffer.from([0x81, 0, 0, 0x80]), bytes]))]);
      append(cluster); cues.push({ timestamp, position: clusterAt }); digest.update(bytes);
      encodedBytes += bytes.length; maxFrameBytes = Math.max(maxFrameBytes, bytes.length); frames++;
      if (frames % 120 === 0) console.log(`ENCODE ${frames} real VP8 frames; ${encodedBytes} bytes`);
    }
    const cuesAt = position - segmentAt;
    append(master('1c53bb6b', cues.map(cue => master('bb', [number('b3', cue.timestamp), master('b7', [number('f7', 1), number('f1', cue.position, 6)])]))));
    fs.writeSync(fd, size(position - segmentAt), 0, 8, sizeAt);
    const seekBytes = seek(cuesAt); fs.writeSync(fd, seekBytes, 0, seekBytes.length, seekAt);
    const infoBytes = info(frames * 1000 / fps); fs.writeSync(fd, infoBytes, 0, infoBytes.length, infoAt);
    fs.fsyncSync(fd);
    await win.webContents.executeJavaScript('window.__closeEncoder()', true);
    return { ...supported, fps, frames, durationSeconds: frames / fps, bytes: position, encodedBytes, containerBytes: position - encodedBytes, maxFrameBytes, framePayloadSha256: digest.digest('hex'), elapsedMs: Date.now() - started, method: 'new canvas noise + numbered overlay → WebCodecs VP8 keyframes → streamed WebM clusters with duration/SeekHead/Cues; no padding' };
  } finally { fs.closeSync(fd); }
};
