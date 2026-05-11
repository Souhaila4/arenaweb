import 'dotenv/config';
import { BigQuery } from '@google-cloud/bigquery';

async function main() {
  const projectId = process.env.BIGQUERY_PROJECT_ID!;
  const datasetId = process.env.BIGQUERY_DATASET!;
  const credentials = JSON.parse(process.env.BIGQUERY_CREDENTIALS!);

  const bq = new BigQuery({ projectId, credentials });

  // List tables
  const [tables] = await bq.dataset(datasetId).getTables();
  console.log(`\nTables in ${projectId}.${datasetId}:\n`);
  for (const t of tables) {
    console.log(`  • ${t.id}`);
  }
  console.log();

  // For each, print the schema (first 30 columns)
  for (const t of tables) {
    const [meta] = await t.getMetadata();
    const fields = (meta.schema?.fields ?? []) as Array<{ name: string; type: string }>;
    console.log(`── ${t.id} (${fields.length} cols) ──`);
    for (const f of fields.slice(0, 30)) console.log(`  ${f.name.padEnd(28)} ${f.type}`);
    console.log();
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
