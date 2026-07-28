import { describe, expect, it } from "vitest";
import {
  formatClockMinutes,
  formatResumeWindow,
  isResumeAllowed,
  isWithinResumeWindow,
  localMinuteOfDay,
  parseClockMinutes,
  parseResumeWindow,
  RESUME_WINDOW_ENV,
  type ResumeWindow,
  resumeWindowFromEnv,
} from "../src/window.js";

describe("parseClockMinutes", () => {
  it("parses HH:MM", () => {
    expect(parseClockMinutes("09:30")).toBe(9 * 60 + 30);
    expect(parseClockMinutes("00:00")).toBe(0);
    expect(parseClockMinutes("23:59")).toBe(23 * 60 + 59);
  });

  it("takes a bare hour as :00 and tolerates single digits + whitespace", () => {
    expect(parseClockMinutes("9")).toBe(9 * 60);
    expect(parseClockMinutes(" 18 ")).toBe(18 * 60);
    expect(parseClockMinutes("6:05")).toBe(6 * 60 + 5);
  });

  it("rejects out-of-range or malformed tokens", () => {
    expect(parseClockMinutes("24:00")).toBeNull();
    expect(parseClockMinutes("9:60")).toBeNull();
    expect(parseClockMinutes("9:5")).toBeNull(); // minutes must be two digits
    expect(parseClockMinutes("abc")).toBeNull();
    expect(parseClockMinutes("")).toBeNull();
    expect(parseClockMinutes("9:30pm")).toBeNull();
  });
});

describe("parseResumeWindow", () => {
  it("parses a same-day window", () => {
    expect(parseResumeWindow("09:00-18:00")).toEqual({ startMinute: 540, endMinute: 1080 });
  });

  it("parses an overnight (wrapping) window", () => {
    expect(parseResumeWindow("22:00-06:00")).toEqual({ startMinute: 1320, endMinute: 360 });
  });

  it("accepts bare hours and surrounding whitespace", () => {
    expect(parseResumeWindow(" 9-17 ")).toEqual({ startMinute: 540, endMinute: 1020 });
  });

  it("returns null for blank, malformed, or equal-endpoint input", () => {
    expect(parseResumeWindow("")).toBeNull();
    expect(parseResumeWindow("   ")).toBeNull();
    expect(parseResumeWindow("09:00")).toBeNull(); // missing the second half
    expect(parseResumeWindow("09:00-18:00-20:00")).toBeNull();
    expect(parseResumeWindow("25:00-26:00")).toBeNull();
    expect(parseResumeWindow("09:00-09:00")).toBeNull(); // ambiguous empty-vs-all-day
  });
});

describe("isWithinResumeWindow", () => {
  const day: ResumeWindow = { startMinute: 540, endMinute: 1080 }; // 09:00-18:00
  const night: ResumeWindow = { startMinute: 1320, endMinute: 360 }; // 22:00-06:00

  it("uses a half-open [start, end) range for same-day windows", () => {
    expect(isWithinResumeWindow(540, day)).toBe(true); // 09:00 — inclusive start
    expect(isWithinResumeWindow(720, day)).toBe(true); // 12:00
    expect(isWithinResumeWindow(1079, day)).toBe(true); // 17:59
    expect(isWithinResumeWindow(1080, day)).toBe(false); // 18:00 — exclusive end
    expect(isWithinResumeWindow(539, day)).toBe(false); // 08:59
  });

  it("handles overnight wraparound", () => {
    expect(isWithinResumeWindow(1320, night)).toBe(true); // 22:00
    expect(isWithinResumeWindow(0, night)).toBe(true); // midnight
    expect(isWithinResumeWindow(359, night)).toBe(true); // 05:59
    expect(isWithinResumeWindow(360, night)).toBe(false); // 06:00 — exclusive end
    expect(isWithinResumeWindow(720, night)).toBe(false); // noon
  });

  it("treats an (invalid) equal-endpoint window as empty", () => {
    expect(isWithinResumeWindow(600, { startMinute: 600, endMinute: 600 })).toBe(false);
  });
});

describe("localMinuteOfDay", () => {
  it("returns local hours*60 + minutes", () => {
    const d = new Date(2026, 0, 15, 14, 37, 12);
    expect(localMinuteOfDay(d)).toBe(14 * 60 + 37);
  });
});

describe("isResumeAllowed", () => {
  it("always allows when no window is configured", () => {
    const anytime = new Date(2026, 0, 15, 3, 0, 0);
    expect(isResumeAllowed(anytime, null)).toBe(true);
  });

  it("gates on the local time-of-day when a window is set", () => {
    const window: ResumeWindow = { startMinute: 540, endMinute: 1080 }; // 09:00-18:00
    const inside = new Date(2026, 0, 15, 10, 0, 0);
    const outside = new Date(2026, 0, 15, 20, 0, 0);
    expect(isResumeAllowed(inside, window)).toBe(true);
    expect(isResumeAllowed(outside, window)).toBe(false);
  });
});

describe("resumeWindowFromEnv", () => {
  it("reads and parses the env var", () => {
    expect(resumeWindowFromEnv({ [RESUME_WINDOW_ENV]: "08:00-12:00" })).toEqual({ startMinute: 480, endMinute: 720 });
  });

  it("returns null when unset or blank", () => {
    expect(resumeWindowFromEnv({})).toBeNull();
    expect(resumeWindowFromEnv({ [RESUME_WINDOW_ENV]: "  " })).toBeNull();
  });

  it("fails open (null) on a malformed value rather than blocking all resumes", () => {
    expect(resumeWindowFromEnv({ [RESUME_WINDOW_ENV]: "nonsense" })).toBeNull();
  });
});

describe("formatClockMinutes / formatResumeWindow", () => {
  it("zero-pads clock minutes", () => {
    expect(formatClockMinutes(0)).toBe("00:00");
    expect(formatClockMinutes(9 * 60 + 5)).toBe("09:05");
    expect(formatClockMinutes(23 * 60 + 59)).toBe("23:59");
  });

  it("renders a window with an en dash", () => {
    expect(formatResumeWindow({ startMinute: 540, endMinute: 1080 })).toBe("09:00–18:00");
  });
});
