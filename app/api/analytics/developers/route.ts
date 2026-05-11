import { NextRequest, NextResponse } from "next/server";
import { BigQuery } from "@google-cloud/bigquery";

// ─────────────────────────────────────────────────────────────────
// Initialize BigQuery once per Node process (singleton).
// ─────────────────────────────────────────────────────────────────
let bqClient: BigQuery | null | undefined;

function getBigQuery(): BigQuery | null {
  if (bqClient !== undefined) return bqClient;
  try {
    const credsStr = process.env.BIGQUERY_CREDENTIALS;
    const projectId = process.env.BIGQUERY_PROJECT_ID || "arena-of-coders";
    if (!credsStr) {
      console.warn("⚠️ BIGQUERY_CREDENTIALS not configured");
      bqClient = null;
      return null;
    }
    const credentials = JSON.parse(credsStr);
    if (!credentials.client_email || !credentials.private_key) {
      console.warn("⚠️ BIGQUERY_CREDENTIALS missing client_email / private_key");
      bqClient = null;
      return null;
    }
    bqClient = new BigQuery({ projectId, credentials });
    console.log(`✅ BigQuery client ready (project=${projectId})`);
    return bqClient;
  } catch (err) {
    console.warn("⚠️ Failed to initialize BigQuery:", err);
    bqClient = null;
    return null;
  }
}

const DATASET = process.env.BIGQUERY_DATASET || "arenaofcoders";

interface Developer {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  mainSpecialty: string;
  skillTags: string[];
  totalChallenges: number;
  totalWins: number;
  winRate: number;
  avgScore: number;
  cvUrl?: string;
}

const MOCK_DEVELOPERS: Developer[] = [
  { id: "1", firstName: "Ahmed", lastName: "Mohammed", email: "ahmed@example.com", mainSpecialty: "FULLSTACK", skillTags: ["React", "Node.js", "PostgreSQL", "Docker"], totalChallenges: 45, totalWins: 32, winRate: 71, avgScore: 8.7 },
  { id: "2", firstName: "Fatima", lastName: "Al-Zahra", email: "fatima@example.com", mainSpecialty: "FRONTEND", skillTags: ["Vue.js", "Tailwind CSS", "TypeScript", "Figma"], totalChallenges: 38, totalWins: 28, winRate: 74, avgScore: 8.4 },
];

function normalizeRow(row: Record<string, unknown>): Developer {
  // skill_tags may arrive as ARRAY<STRING>, a JSON string, or a CSV.
  let skillTags: string[] = [];
  const raw = row.skill_tags;
  if (Array.isArray(raw)) {
    skillTags = raw as string[];
  } else if (typeof raw === "string" && raw.length) {
    try {
      const parsed = JSON.parse(raw);
      skillTags = Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      skillTags = raw.split(",").map((s) => s.trim()).filter(Boolean);
    }
  }

  const totalChallenges = Number(row.total_challenges ?? 0) || 0;
  const totalWins = Number(row.total_wins ?? 0) || 0;
  // win_rate may be stored as a fraction (0..1) or as a percentage (0..100).
  const rawRate = Number(row.win_rate ?? 0) || 0;
  const rateScaled = rawRate > 0 && rawRate <= 1 ? rawRate * 100 : rawRate;
  const winRate =
    rateScaled > 0
      ? Math.round(rateScaled)
      : totalChallenges > 0
        ? Math.round((totalWins / totalChallenges) * 100)
        : 0;

  return {
    id: String(row.developer_id ?? ""),
    firstName: String(row.first_name ?? ""),
    lastName: String(row.last_name ?? ""),
    email: String(row.email ?? ""),
    mainSpecialty: String(row.main_specialty ?? "FULLSTACK"),
    skillTags,
    totalChallenges,
    totalWins,
    winRate,
    avgScore: Math.round(Number(row.avg_score ?? 0) * 10) / 10,
    cvUrl: typeof row.cv_url === "string" ? row.cv_url : undefined,
  };
}

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const tier = searchParams.get("tier") || "PRO";
  const specialty = searchParams.get("specialty");
  const limit = tier === "BASIC" ? 10 : 500;

  const bq = getBigQuery();
  if (!bq) {
    return NextResponse.json({
      tier,
      developers: MOCK_DEVELOPERS,
      total: MOCK_DEVELOPERS.length,
      _source: "mock",
      _reason: "BIGQUERY_CREDENTIALS not configured",
    });
  }

  // Parameterized query (no SQL injection on the specialty filter).
  const params: Record<string, unknown> = {};
  let where = "developer_id IS NOT NULL";
  if (specialty) {
    where += " AND UPPER(main_specialty) = @specialty";
    params.specialty = specialty.toUpperCase();
  }

  // dim_developers is the cleaned/canonical table; fall back to staging_developers if needed.
  const tablesToTry = ["dim_developers", "staging_developers"];

  for (const tableName of tablesToTry) {
    const sql = `
      SELECT
        developer_id,
        first_name,
        last_name,
        email,
        IFNULL(main_specialty, 'FULLSTACK')   AS main_specialty,
        IFNULL(skill_tags, ARRAY<STRING>[])   AS skill_tags,
        IFNULL(total_challenges, 0)           AS total_challenges,
        IFNULL(total_wins, 0)                 AS total_wins,
        IFNULL(win_rate, 0)                   AS win_rate,
        IFNULL(avg_score, 0)                  AS avg_score,
        cv_url
      FROM \`${process.env.BIGQUERY_PROJECT_ID}.${DATASET}.${tableName}\`
      WHERE ${where}
      ORDER BY IFNULL(avg_score, 0) DESC, IFNULL(total_wins, 0) DESC
      LIMIT ${limit}
    `;
    try {
      const [rows] = await bq.query({ query: sql, params });
      if (rows.length > 0) {
        const developers = (rows as Record<string, unknown>[]).map(normalizeRow);
        return NextResponse.json({
          tier,
          developers,
          total: developers.length,
          _source: "bigquery",
          _table: tableName,
        });
      }
      // 0 rows from this table → try the next one
    } catch (err) {
      console.warn(`⚠️ BigQuery query on ${tableName} failed:`, err instanceof Error ? err.message : err);
      // Continue to the next table candidate
    }
  }

  // No data anywhere → mock fallback
  return NextResponse.json({
    tier,
    developers: MOCK_DEVELOPERS,
    total: MOCK_DEVELOPERS.length,
    _source: "mock",
    _reason: "All BigQuery tables empty or unreachable",
  });
}
