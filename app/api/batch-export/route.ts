// Proxies to exportcomments.com so the browser doesn't hit their CORS restriction
// (server-to-server requests aren't subject to CORS).
import { NextRequest, NextResponse } from "next/server";

const UPSTREAM = "https://exportcomments.com/api/v1/batch-export";

export async function POST(req: NextRequest) {
  const auth = req.headers.get("authorization");
  if (!auth) return NextResponse.json({ error: "Missing Authorization header" }, { status: 401 });

  const body = await req.text();
  const res = await fetch(UPSTREAM, {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/json" },
    body,
  });
  const data = await res.text();
  return new NextResponse(data, { status: res.status, headers: { "Content-Type": "application/json" } });
}

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization");
  if (!auth) return NextResponse.json({ error: "Missing Authorization header" }, { status: 401 });

  const batchId = req.nextUrl.searchParams.get("batchId");
  if (!batchId) return NextResponse.json({ error: "Missing batchId" }, { status: 400 });

  const res = await fetch(`${UPSTREAM}/${batchId}`, { headers: { Authorization: auth } });
  const data = await res.text();
  return new NextResponse(data, { status: res.status, headers: { "Content-Type": "application/json" } });
}
