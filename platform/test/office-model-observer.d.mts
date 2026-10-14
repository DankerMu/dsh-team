export declare function apply(
  ctx: {
    on(
      name: 'session/event',
      listener: (
        session: { header: { id: string; origin?: string; parentSession?: string } },
        event: { type: string; seq: number; data: Record<string, unknown> },
      ) => void,
    ): void;
  },
  config: { control: string; evidence: string },
): void;
