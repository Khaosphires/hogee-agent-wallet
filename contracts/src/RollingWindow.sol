// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

/// @title RollingWindow: an exact sliding-window sum per line (§8.4 rolling-window caps, T22).
/// @notice Each spend is stored with its time; it counts while `now < spentAt + windowSeconds`, using the line's
///         CURRENT window. Entries are in arrival order, so their expiries are ordered and expired entries are popped
///         from the head (amortised O(1)). Entries with the same time (same block) are merged. The caller bounds the
///         live entry count (Treasury: 64 per window), which also bounds the pops per call. windowSeconds can only
///         grow after version 1 (a re-commit may only tighten, G0 audit v-1), so a longer window also covers the
///         spends already in it and the order never breaks.
library RollingWindow {
    struct Entry {
        uint64 spentAt;
        uint128 amountMinor;
    }

    struct Queue {
        uint64 head; // first live entry
        uint64 tail; // next free index
        uint128 sumMinor; // sum of entries [head, tail)
        mapping(uint64 index => Entry) entries;
    }

    /// Pops the entries that left the window from the head.
    function prune(Queue storage q, uint64 now_, uint32 windowSeconds) internal {
        uint64 h = q.head;
        uint64 t = q.tail;
        uint128 s = q.sumMinor;
        while (h < t) {
            Entry storage e = q.entries[h];
            if (_live(e, now_, windowSeconds)) break;
            s -= e.amountMinor;
            delete q.entries[h];
            ++h;
        }
        q.head = h;
        q.sumMinor = s;
    }

    /// The sum and entry count `prune` would leave, without writing.
    function live(Queue storage q, uint64 now_, uint32 windowSeconds)
        internal
        view
        returns (uint128 sumMinor, uint64 count)
    {
        uint64 h = q.head;
        uint64 t = q.tail;
        sumMinor = q.sumMinor;
        while (h < t) {
            Entry storage e = q.entries[h];
            if (_live(e, now_, windowSeconds)) break;
            sumMinor -= e.amountMinor;
            ++h;
        }
        count = t - h;
    }

    /// Appends a spend made at `spentAt` (now); call `prune` first.
    function push(Queue storage q, uint64 spentAt, uint128 amountMinor) internal {
        uint64 t = q.tail;
        q.sumMinor += amountMinor;
        if (t > q.head) {
            Entry storage last = q.entries[t - 1];
            if (last.spentAt == spentAt) {
                last.amountMinor += amountMinor;
                return;
            }
        }
        q.entries[t] = Entry({spentAt: spentAt, amountMinor: amountMinor});
        q.tail = t + 1;
    }

    function _live(Entry storage e, uint64 now_, uint32 windowSeconds) private view returns (bool) {
        return uint256(e.spentAt) + windowSeconds > now_;
    }
}
