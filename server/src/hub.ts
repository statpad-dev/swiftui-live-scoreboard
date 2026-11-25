import type { Change, GameDetail } from '@statpad/sdk';

// The entity types the scoreboard draws. The game stream also carries play groups,
// rosters and player stats, which this server drops instead of forwarding.
const KEEP = new Set(['game', 'live_state', 'team', 'play']);
const JOURNAL_CAP = 2000;

export type Entity = Pick<Change, 'entity_type' | 'entity_id' | 'version' | 'payload'>;
export type Snapshot = { seq: number; entities: Entity[] };
export type HubEvent = { type: 'snapshot'; seq: number; data: Snapshot } | { type: 'changes'; seq: number; data: Change[] };
type Listener = (event: HubEvent) => void;

export function entitiesOf(detail: GameDetail): Entity[] {
  const entity = (entity_type: Entity['entity_type'], entity_id: string, payload: { version: number }) =>
    ({ entity_type, entity_id, version: payload.version, payload }) as Entity;
  const entities = [
    entity('game', detail.game.id, detail.game),
    entity('team', detail.home_team.id, detail.home_team),
    entity('team', detail.away_team.id, detail.away_team),
  ];
  if (detail.live_state) entities.push(entity('live_state', detail.game.id, detail.live_state));
  return entities;
}

export class GameHub {
  seq = 0;
  private entities = new Map<string, Entity>();
  private journal: Change[] = [];
  private journalFrom = 0;
  private listeners = new Set<Listener>();

  constructor(
    readonly league: 'nfl' | 'ncaaf' | 'epl',
    readonly gameId: string,
  ) {}

  // Authoritative state from a game read (getGame and listPlays, or game.json in replay).
  // It replaces everything the hub held, and every connected phone gets it as a snapshot.
  load(seq: number, entities: Entity[]) {
    this.entities = new Map(entities.map((e) => [`${e.entity_type}:${e.entity_id}`, e]));
    this.seq = seq;
    this.journal = [];
    this.journalFrom = seq;
    const event: HubEvent = { type: 'snapshot', seq, data: this.snapshot() };
    for (const listener of this.listeners) listener(event);
  }

  // One changes message from Statpad, applied whole and forwarded as one event.
  apply(changes: Change[]) {
    const fresh = changes.filter((c) => c.seq > this.seq);
    if (fresh.length === 0) return;
    if (fresh[0].seq !== this.seq + 1) throw new Error(`gap: holding ${this.seq}, got ${fresh[0].seq}`);
    const kept = fresh.filter((c) => KEEP.has(c.entity_type));
    for (const c of kept) {
      const key = `${c.entity_type}:${c.entity_id}`;
      if (c.op === 'delete') this.entities.delete(key);
      else this.entities.set(key, c);
    }
    this.seq = fresh[fresh.length - 1].seq;
    this.journal.push(...kept);
    if (this.journal.length > JOURNAL_CAP) {
      this.journalFrom = this.journal[this.journal.length - JOURNAL_CAP - 1].seq;
      this.journal = this.journal.slice(-JOURNAL_CAP);
    }
    if (kept.length === 0) return;
    const event: HubEvent = { type: 'changes', seq: this.seq, data: kept };
    for (const listener of this.listeners) listener(event);
  }

  // The changes after a phone's Last-Event-ID, or undefined when the journal can't cover it.
  since(seq: number): Change[] | undefined {
    if (seq < this.journalFrom || seq > this.seq) return undefined;
    return this.journal.filter((c) => c.seq > seq);
  }

  snapshot(): Snapshot {
    return { seq: this.seq, entities: [...this.entities.values()] };
  }

  subscribe(listener: Listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
