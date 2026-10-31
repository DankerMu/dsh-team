interface SessionEvent {
  type: string;
  seq: number;
  data: Record<string, unknown>;
}

export declare function apply(
  ctx: {
    on(
      name: 'session/event',
      listener: (
        session: {
          header: { id: string; origin?: string; parentSession?: string; agentPreset?: string };
          /** The committed log prefix, read once when the observer first sees the Session. */
          snapshotEvents(fromSeq: number, toSeqExclusive: number): readonly SessionEvent[];
        },
        event: SessionEvent,
      ) => void,
    ): void;
  },
  config: { control: string; evidence: string },
): void;
