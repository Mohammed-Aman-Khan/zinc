export declare const MSG_CALL:  number;
export declare const MSG_REPLY: number;
export declare const MSG_EVENT: number;
export declare const MSG_PING:  number;
export declare const MSG_PONG:  number;
export declare const MSG_ERROR: number;

export interface ReceivedMessage {
  msgType:       number;
  msgId:         bigint;
  correlationId: bigint;
  senderPid:     number;
  payload:       Buffer;
}

export interface RingStats {
  used: bigint;
  free: bigint;
}

export declare class UIPCRingHandle {
  constructor(name: string, create: boolean);


  send(msgType: number, payload: Buffer, correlationId?: bigint): void;

  sendCall(payload: Buffer): bigint;

  emit(payload: Buffer): void;


  poll(): ReceivedMessage | null;

  drain(): ReceivedMessage[];

  waitForReply(waitForId: bigint, timeoutMs: number): Promise<ReceivedMessage | null>;


  stats(): RingStats;

  unlink(): void;

  close(): void;

  static maxPayloadSize(): number;
}
