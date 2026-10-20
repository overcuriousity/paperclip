import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { companies, companyMemberships, createDb, issueRelations, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { ensureHumanRoleDefaultGrants } from "../services/principal-access-compatibility.js";

// PATCH /issues/:id echoes blockedByIssueIds; the reads must return the same
// key so a caller can check a blocker without mapping blockedBy (MIK-735).
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue blockedByIssueIds route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issue read routes blockedByIssueIds", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let app!: express.Express;
  const companyId = randomUUID();
  // blocked waits on blockerA and blockerB; free has no blockers.
  const ids = { blocked: randomUUID(), blockerA: randomUUID(), blockerB: randomUUID(), free: randomUUID() };
  const sorted = (list: string[]) => [...list].sort();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-blocked-by-ids-routes-");
    db = createDb(tempDb.connectionString);
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `B${randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: "cloud-user-1",
      status: "active",
      membershipRole: "owner",
      updatedAt: new Date(),
    });
    await ensureHumanRoleDefaultGrants(db, {
      companyId,
      principalId: "cloud-user-1",
      membershipRole: "owner",
      grantedByUserId: null,
    });
    for (const [title, id] of Object.entries(ids)) {
      await db.insert(issues).values({
        id,
        companyId,
        title,
        status: title === "blocked" ? "blocked" : "todo",
        priority: "medium",
      });
    }
    for (const blocker of [ids.blockerA, ids.blockerB]) {
      await db.insert(issueRelations).values({
        companyId,
        issueId: blocker,
        relatedIssueId: ids.blocked,
        type: "blocks",
      });
    }

    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        userId: "cloud-user-1",
        companyIds: [companyId],
        memberships: [{ companyId, membershipRole: "owner", status: "active" }],
        source: "cloud_tenant",
        isInstanceAdmin: false,
      };
      next();
    });
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function get(path: string) {
    const res = await request(app).get(`/api${path}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body;
  }

  it("GET /issues/:id returns blockedByIssueIds matching blockedBy", async () => {
    const issue = await get(`/issues/${ids.blocked}`);
    expect(issue.blockedByIssueIds).toEqual(sorted([ids.blockerA, ids.blockerB]));
    expect(issue.blockedByIssueIds).toEqual(sorted(issue.blockedBy.map((b: { id: string }) => b.id)));
  });

  it("GET /issues/:id returns [] when nothing blocks the issue", async () => {
    const issue = await get(`/issues/${ids.free}`);
    expect(issue.blockedByIssueIds).toEqual([]);
  });

  it("the company issues list carries blockedByIssueIds on every row without includeBlockedBy", async () => {
    const rows = await get(`/companies/${companyId}/issues`);
    expect(rows).toHaveLength(4);
    const byId = new Map<string, any>(rows.map((row: any) => [row.id, row]));
    for (const row of byId.values()) expect(Array.isArray(row.blockedByIssueIds), row.title).toBe(true);
    expect(byId.get(ids.blocked).blockedByIssueIds).toEqual(sorted([ids.blockerA, ids.blockerB]));
    expect(byId.get(ids.free).blockedByIssueIds).toEqual([]);
    expect(byId.get(ids.blocked).blockedBy, "blockedBy stays opt-in").toBeUndefined();
  });

  it("the company issues list with includeBlockedBy keeps both keys in step", async () => {
    const rows = await get(`/companies/${companyId}/issues?includeBlockedBy=true`);
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row.blockedByIssueIds).toEqual(sorted(row.blockedBy.map((b: { id: string }) => b.id)));
    }
  });
});
