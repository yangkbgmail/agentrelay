import { describe, expect, it } from "vitest";
import {
  type ActiveWindow,
  activeWindowFromEnv,
  formatActiveWindow,
  isMinuteWithinWindow,
  isWithinActiveWindow,
  minutesUntilWindowOpens,
  nextWindowOpen,
  parseActiveHours,
} from "./window.js";

describe("parseActiveHours", () => {
  it("parses explicit HH:MM-HH:MM", () => {
    expect(parseActiveHours("22:00-06:00")).toEqual({ startMinute: 22 * 60, endMinute: 6 * 60 });
  });

  it("parses bare hours (minutes default to :00)", () => {
    expect(parseActiveHours("9-17")).toEqual({ startMinute: 9 * 60, endMinute: 17 * 60 });
  });

  it("parses mixed HH:MM and bare-hour sides, tolerating whitespace around the dash", () => {
    expect(parseActiveHours("22:30 - 6")).toEqual({ startMinute: 22 * 60 + 30, endMinute: 6 * 60 });
  });

  it("returns null for unset/empty/non-string input", () => {
    expect(parseActiveHours(undefined)).toBeNull();
    expect(parseActiveHours(null)).toBeNull();
    expect(parseActiveHours("")).toBeNull();
    expect(parseActiveHours("   ")).toBeNull();
  });

  it("returns null for a zero-width window (ambiguous all-day vs no-day)", () => {
    expect(parseActiveHours("09:00-09:00")).toBeNull();
    expect(parseActiveHours("9-9")).toBeNull();
  });

  it("returns null for out-of-range hours/minutes", () => {
    expect(parseActiveHours("24:00-06:00")).toBeNull();
    expect(parseActiveHours("09:60-10:00")).toBeNull();
    expect(parseActiveHours("25-30")).toBeNull();
  });

  it("returns null for malformed specs", () => {
    expect(parseActiveHours("9 to 5")).toBeNull();
    expect(parseActiveHours("09:00")).toBeNull();
    expect(parseActiveHours("morning")).toBeNull();
    expect(parseActiveHours("9-17-22")).toBeNull();
  });
});

describe("isMinuteWithinWindow", () => {
  const day: ActiveWindow = { startMinute: 9 * 60, endMinute: 17 * 60 }; // 09:00-17:00

  it("treats start as inclusive and end as exclusive for a same-day window", () => {
    expect(isMinuteWithinWindow(day, 9 * 60)).toBe(true); // 09:00 exactly
    expect(isMinuteWithinWindow(day, 12 * 60)).toBe(true);
    expect(isMinuteWithinWindow(day, 17 * 60 - 1)).toBe(true); // 16:59
    expect(isMinuteWithinWindow(day, 17 * 60)).toBe(false); // 17:00 exactly
    expect(isMinuteWithinWindow(day, 8 * 60 + 59)).toBe(false);
  });

  const night: ActiveWindow = { startMinute: 22 * 60, endMinute: 6 * 60 }; // 22:00-06:00

  it("wraps past midnight for an overnight window", () => {
    expect(isMinuteWithinWindow(night, 22 * 60)).toBe(true); // 22:00
    expect(isMinuteWithinWindow(night, 23 * 60 + 30)).toBe(true); // 23:30
    expect(isMinuteWithinWindow(night, 0)).toBe(true); // midnight
    expect(isMinuteWithinWindow(night, 5 * 60 + 59)).toBe(true); // 05:59
    expect(isMinuteWithinWindow(night, 6 * 60)).toBe(false); // 06:00 exactly
    expect(isMinuteWithinWindow(night, 12 * 60)).toBe(false); // midday
  });

  it("normalizes out-of-range minutes into the day", () => {
    expect(isMinuteWithinWindow(day, 12 * 60 + 1440)).toBe(true); // next-day noon
    expect(isMinuteWithinWindow(day, -1)).toBe(false); // wraps to 23:59
  });
});

describe("minutesUntilWindowOpens", () => {
  const day: ActiveWindow = { startMinute: 9 * 60, endMinute: 17 * 60 };

  it("is 0 while inside the window", () => {
    expect(minutesUntilWindowOpens(day, 10 * 60)).toBe(0);
    expect(minutesUntilWindowOpens(day, 9 * 60)).toBe(0);
  });

  it("counts forward to the next start when before the window", () => {
    expect(minutesUntilWindowOpens(day, 8 * 60)).toBe(60); // 08:00 -> 09:00
  });

  it("wraps past midnight when after the window", () => {
    expect(minutesUntilWindowOpens(day, 18 * 60)).toBe((9 + 24 - 18) * 60); // 18:00 -> next 09:00 = 15h
  });

  const night: ActiveWindow = { startMinute: 22 * 60, endMinute: 6 * 60 };

  it("counts to the evening start when in the daytime gap of an overnight window", () => {
    expect(minutesUntilWindowOpens(night, 12 * 60)).toBe(10 * 60); // 12:00 -> 22:00
  });
});

describe("Date-facing helpers use local time", () => {
  const win: ActiveWindow = { startMinute: 9 * 60, endMinute: 17 * 60 }; // 09:00-17:00

  it("isWithinActiveWindow reads the Date's local hours/minutes", () => {
    const inside = new Date(2026, 0, 2, 10, 30, 0); // 10:30 local
    const outside = new Date(2026, 0, 2, 20, 0, 0); // 20:00 local
    expect(isWithinActiveWindow(win, inside)).toBe(true);
    expect(isWithinActiveWindow(win, outside)).toBe(false);
  });

  it("nextWindowOpen returns the same instant when already inside", () => {
    const inside = new Date(2026, 0, 2, 10, 0, 0);
    expect(nextWindowOpen(win, inside).getTime()).toBe(inside.getTime());
  });

  it("nextWindowOpen jumps forward to the next open minute when outside", () => {
    const outside = new Date(2026, 0, 2, 8, 0, 0); // 08:00 local
    const opened = nextWindowOpen(win, outside);
    expect(opened.getHours()).toBe(9);
    expect(opened.getMinutes()).toBe(0);
  });
});

describe("formatActiveWindow", () => {
  it("round-trips a parsed window back to a zero-padded HH:MM-HH:MM string", () => {
    expect(formatActiveWindow({ startMinute: 22 * 60, endMinute: 6 * 60 })).toBe("22:00-06:00");
    expect(formatActiveWindow({ startMinute: 9 * 60 + 5, endMinute: 17 * 60 })).toBe("09:05-17:00");
  });
});

describe("activeWindowFromEnv", () => {
  it("reads AGENTRELAY_ACTIVE_HOURS", () => {
    expect(activeWindowFromEnv({ AGENTRELAY_ACTIVE_HOURS: "22:00-06:00" } as NodeJS.ProcessEnv)).toEqual({
      startMinute: 22 * 60,
      endMinute: 6 * 60,
    });
  });

  it("returns null when unset or invalid", () => {
    expect(activeWindowFromEnv({} as NodeJS.ProcessEnv)).toBeNull();
    expect(activeWindowFromEnv({ AGENTRELAY_ACTIVE_HOURS: "nope" } as NodeJS.ProcessEnv)).toBeNull();
  });
});
