const MAX = 5000;

class Ring {
  constructor(max = MAX) { this.max = max; this.arr = []; }
  push(x) { this.arr.push(x); if (this.arr.length > this.max) this.arr.shift(); }
  list() { return this.arr.slice().reverse(); }
}

module.exports = {
  messages: new Ring(),   // every received JT808 frame (raw hex + parsed)
  alerts:   new Ring(),   // alarm-only entries (location alarms + ADAS/DSM/BSD)
  media:    new Ring(),   // saved media files (alarm attachments + FTP uploads)
  terminals: new Map(),   // phone -> { socket, lastSeen, authCode, registered }
};
