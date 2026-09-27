/**
 * MyoLift watch app (lite wearable, JS): streams accelerometer + heart rate to the MyoLift phone app
 * over Wear Engine P2P. Samples are batched (default ~50 Hz, sent every 10 samples) and carry the
 * watch's own millisecond clock; the phone stamps arrival on its clock so the two can be aligned.
 * wearengine.js comes from Huawei's Wear Engine SDK for lite wearables (see README).
 */
import sensor from '@system.sensor';
import { P2pClient, Message, Builder } from '../../wearengine';

const PHONE_PKG = 'com.mohitburkule.myolift';
// SHA-256 of the MyoLift release signing certificate (public; from CI's release.p12)
const PHONE_FINGERPRINT = '97CAA89A94A09460E4A4B930B715F8AD7991ED04352C5F88D3FDAD51446E8D3D';
const BATCH = 10;

let p2p = null;
let buf = [];

export default {
  data: { status: 'ready', hr: '–', sent: 0, running: false },

  onInit() {
    p2p = new P2pClient();
    p2p.setPeerPkgName(PHONE_PKG);
    p2p.setPeerFingerPrint(PHONE_FINGERPRINT);
    const self = this;
    p2p.registerReceiver({
      onSuccess() { self.status = 'linked to phone'; },
      onFailure() { self.status = 'phone link failed'; },
      onReceiveMessage(data) {
        // the phone can start/stop streaming: {"type":"start"} / {"type":"stop"}
        try {
          const m = JSON.parse(typeof data === 'string' ? data : data.data);
          if (m.type === 'start' && !self.running) self.toggle();
          if (m.type === 'stop' && self.running) self.toggle();
        } catch (e) {}
      },
    });
  },

  send(obj) {
    const b = new Builder();
    b.setDescription(JSON.stringify(obj));
    const msg = new Message();
    msg.builder = b;
    const self = this;
    p2p.send(msg, {
      onSuccess() { self.sent += 1; },
      onFailure() { self.status = 'send failed'; },
      onSendResult(code) { if (code !== 207) self.status = 'send result ' + code; },
      onSendProgress() {},
    });
  },

  toggle() {
    const self = this;
    if (this.running) {
      sensor.unsubscribeAccelerometer();
      sensor.unsubscribeHeartRate();
      if (buf.length) { this.send({ type: 'acc', s: buf }); buf = []; }
      this.send({ type: 'stop', t: Date.now() });
      this.running = false;
      this.status = 'stopped';
      return;
    }
    this.running = true;
    this.status = 'streaming';
    this.send({ type: 'start', t: Date.now() });
    // interval: 'game' ≈ 20 ms, 'ui' ≈ 60 ms, 'normal' ≈ 200 ms
    sensor.subscribeAccelerometer({
      interval: 'game',
      success(ret) {
        buf.push([Date.now(), ret.x, ret.y, ret.z]);
        if (buf.length >= BATCH) { self.send({ type: 'acc', s: buf }); buf = []; }
      },
      fail(data, code) { self.status = 'accel error ' + code; },
    });
    sensor.subscribeHeartRate({
      success(ret) { self.hr = ret.heartRate; self.send({ type: 'hr', t: Date.now(), v: ret.heartRate }); },
      fail(data, code) { self.hr = 'err ' + code; },
    });
  },

  onDestroy() {
    if (this.running) { sensor.unsubscribeAccelerometer(); sensor.unsubscribeHeartRate(); }
    if (p2p) p2p.unregisterReceiver({ onSuccess() {}, onFailure() {} });
  },
};
