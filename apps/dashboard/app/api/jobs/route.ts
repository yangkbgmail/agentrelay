import { NextResponse } from "next/server";
import { readJobsSnapshot } from "../../../lib/jobs";

// The store file changes outside of Next's knowledge (CLI/daemon writes it),
// so this route must re-read it on every request.
export const dynamic = "force-dynamic";

export function GET() {
  const snapshot = readJobsSnapshot();
  return NextResponse.json(snapshot, {
    headers: { "cache-control": "no-store" },
  });
}
