import { NextRequest, NextResponse } from "next/server";

const UPSTREAM = "https://app.exportcomments.com/api/v1/jobs";

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization");
  if (!auth) return NextResponse.json({ error: "Missing Authorization header" }, { status: 401 });

  const page = req.nextUrl.searchParams.get("page") ?? "1";
  const limit = req.nextUrl.searchParams.get("limit") ?? "25";

  const res = await fetch(`${UPSTREAM}?page=${page}&limit=${limit}`, { headers: { Authorization: auth } });
  const data = await res.text();
  return new NextResponse(data, { status: res.status, headers: { "Content-Type": "application/json" } });
}
