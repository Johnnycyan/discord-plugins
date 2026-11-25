// Types for globals that code shared with the Equicord and Kettu plugins mentions. The Phoenix runtime
// has none of them: Phoenix plugins pass their own replacements (see CustomFavorites' `timers`).
declare function setTimeout(callback: () => void, ms: number): number;
declare function clearTimeout(handle: number): void;
