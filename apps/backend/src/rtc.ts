import { PROTOCOL_VERSION, type RtcMessage } from '@marionette/protocol';

/** One WebRTC connection being set up or running: a viewer's `peer` (its own name for it) on one publisher's stream. */
type Session = { viewer: string; publisher: string; stream: string; peer: string };

/**
 * WebRTC signaling between clients, by client id. The gateway only routes: a viewer's `request` goes to the
 * stream's publisher, then `offer`, `answer`, `candidate`, `close` (and an `error` either end reports) pass between
 * the two ends of that one request, stamped with `from`. Anything else is answered with `error`. The media never
 * comes near the gateway.
 */
export function createSignaling(deps: { send: (clientId: string, message: RtcMessage) => void; publisherOf: (stream: string) => string | undefined }) {
  const sessions = new Map<string, Session>();
  const key = (viewer: string, peer: string) => `${viewer} ${peer}`;
  const rtc = (kind: RtcMessage['kind'], fields: Omit<RtcMessage, 'type' | 'version' | 'kind'>): RtcMessage => ({ type: 'rtc', version: PROTOCOL_VERSION, kind, ...fields });
  const error = (to: string, about: RtcMessage, message: string) => deps.send(to, rtc('error', { ...(about.peer ? { peer: about.peer } : {}), ...(about.stream ? { stream: about.stream } : {}), ...(about.to ? { to: about.to } : {}), message }));
  const end = (session: Session, notify: string, from: string, message?: string) => {
    sessions.delete(key(session.viewer, session.peer));
    deps.send(notify, rtc('close', { peer: session.peer, stream: session.stream, from, ...(message ? { message } : {}) }));
  };
  return {
    request(from: string, message: RtcMessage) {
      if (!message.stream || !message.peer) { error(from, message, 'A request needs the stream and your peer name'); return; }
      const publisher = deps.publisherOf(message.stream);
      if (!publisher) { error(from, message, `Nobody publishes "${message.stream}" over WebRTC`); return; }
      const previous = sessions.get(key(from, message.peer));
      if (previous && previous.publisher !== publisher) end(previous, previous.publisher, from);
      sessions.set(key(from, message.peer), { viewer: from, publisher, stream: message.stream, peer: message.peer });
      deps.send(publisher, rtc('request', { stream: message.stream, peer: message.peer, from }));
    },
    relay(from: string, message: RtcMessage) {
      if (!message.to || !message.peer) { error(from, message, `${message.kind} needs to and peer`); return; }
      if ((message.kind === 'offer' || message.kind === 'answer') && !message.sdp) { error(from, message, `${message.kind} needs sdp`); return; }
      if (message.kind === 'candidate' && !message.candidate) { error(from, message, 'candidate needs candidate'); return; }
      // The sender is the viewer of a session with `to` as its publisher, or the publisher of `to`'s session.
      const mine = sessions.get(key(from, message.peer)); const theirs = sessions.get(key(message.to, message.peer));
      const session = mine?.publisher === message.to ? mine : theirs?.publisher === from ? theirs : undefined;
      if (!session) { error(from, message, `No WebRTC connection "${message.peer}" with ${message.to}`); return; }
      if (message.kind === 'close' || message.kind === 'error') sessions.delete(key(session.viewer, session.peer));
      deps.send(message.to, rtc(message.kind, { peer: message.peer, stream: session.stream, from,
        ...(message.sdp !== undefined ? { sdp: message.sdp } : {}), ...(message.candidate ? { candidate: { candidate: message.candidate.candidate, sdpMid: message.candidate.sdpMid, sdpMLineIndex: message.candidate.sdpMLineIndex } } : {}),
        ...(message.message !== undefined ? { message: message.message } : {}) }));
    },
    /** A client went away: the other end of each of its connections gets `close`. */
    drop(clientId: string) {
      for (const session of [...sessions.values()]) {
        if (session.viewer === clientId) end(session, session.publisher, clientId);
        else if (session.publisher === clientId) end(session, session.viewer, clientId, 'The publisher went away');
      }
    },
    /** A publisher stopped publishing some streams: their viewers get `close`. */
    unpublished(publisher: string, streams: string[]) {
      for (const session of [...sessions.values()]) if (session.publisher === publisher && streams.includes(session.stream)) end(session, session.viewer, publisher, 'The stream is no longer published');
    },
    count: () => sessions.size,
  };
}
