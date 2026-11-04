// Ratings from pairwise votes: Bradley-Terry strengths (the model behind
// Elo-style leaderboards), fitted with the standard MM iteration, shown on
// an Elo-like scale. Ties count as half a win for each side. A light prior
// (one virtual tie per pair) keeps ratings finite when someone never loses.

export type Game = { a: string; b: string; winner: "a" | "b" | "tie" };

export type Standing = { wins: number; losses: number; ties: number; games: number; winRate: number | null; rating: number | null };

export function standings(players: string[], games: Game[]): Map<string, Standing> {
  const out = new Map(players.map((p) => [p, { wins: 0, losses: 0, ties: 0, games: 0, winRate: null as number | null, rating: null as number | null }]));
  for (const game of games) {
    const a = out.get(game.a);
    const b = out.get(game.b);
    if (!a || !b) continue;
    a.games++;
    b.games++;
    if (game.winner === "a") (a.wins++, b.losses++);
    else if (game.winner === "b") (b.wins++, a.losses++);
    else (a.ties++, b.ties++);
  }
  const ratings = bradleyTerry(players, games);
  for (const [player, record] of out) {
    record.winRate = record.games ? (record.wins + record.ties / 2) / record.games : null;
    record.rating = record.games ? ratings.get(player)! : null;
  }
  return out;
}

export function bradleyTerry(players: string[], games: Game[], iterations = 500): Map<string, number> {
  const index = new Map(players.map((p, i) => [p, i]));
  const n = players.length;
  const wins = new Array<number>(n).fill(0);
  const pairs: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (const game of games) {
    const i = index.get(game.a);
    const j = index.get(game.b);
    if (i === undefined || j === undefined || i === j) continue;
    pairs[i]![j]!++;
    pairs[j]![i]!++;
    if (game.winner === "a") wins[i]!++;
    else if (game.winner === "b") wins[j]!++;
    else (wins[i]! += 0.5, wins[j]! += 0.5);
  }
  // Prior: one virtual tie between every pair that met.
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (pairs[i]![j]! === 0) continue;
      pairs[i]![j]!++;
      pairs[j]![i]!++;
      wins[i]! += 0.5;
      wins[j]! += 0.5;
    }
  }
  let strength = new Array<number>(n).fill(1);
  for (let iteration = 0; iteration < iterations; iteration++) {
    const next = strength.map((s, i) => {
      let denominator = 0;
      for (let j = 0; j < n; j++) if (pairs[i]![j]!) denominator += pairs[i]![j]! / (s + strength[j]!);
      return denominator > 0 ? wins[i]! / denominator : s;
    });
    // Normalise to a geometric mean of 1 so the scale stays put.
    const logMean = next.reduce((sum, s) => sum + Math.log(s), 0) / n;
    strength = next.map((s) => s / Math.exp(logMean));
  }
  return new Map(players.map((p, i) => [p, Math.round(1000 + 400 * Math.log10(strength[i]!))]));
}
