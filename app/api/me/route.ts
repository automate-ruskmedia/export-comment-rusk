// Proxies to exportcomments.com's cheap auth-check endpoint so the browser
// doesn't hit CORS. Their response body includes an Argon2 password hash
// (documented bug on their end) — stripped here before it reaches the client.
import { NextRequest, NextResponse } from "next/server";

const UPSTREAM = "https://exportcomments.com/api/v1/me";

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization");
  if (!auth) return NextResponse.json({ error: "Missing Authorization header" }, { status: 401 });

  const res = await fetch(UPSTREAM, { headers: { Authorization: auth } });
  if (!res.ok) {
    return NextResponse.json({ error: `Token check failed (${res.status})` }, { status: res.status });
  }
  const data = await res.json();
  delete data.password;
  return NextResponse.json(data);
}
