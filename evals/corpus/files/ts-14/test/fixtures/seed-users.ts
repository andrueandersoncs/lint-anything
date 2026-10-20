import { hash } from "@node-rs/argon2"
import postgres from "postgres"

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/app_test"

export const TEST_PASSWORD = "test-password"

export interface SeedUser {
  readonly email: string
  readonly name: string
  readonly role: "owner" | "admin" | "member" | "viewer"
  readonly orgSlug: string
  readonly mfaEnabled?: boolean
}

export const seedUsers: ReadonlyArray<SeedUser> = [
  { email: "owner@acme.test", name: "Olivia Owner", role: "owner", orgSlug: "acme", mfaEnabled: true },
  { email: "admin@acme.test", name: "Arjun Admin", role: "admin", orgSlug: "acme" },
  { email: "member@acme.test", name: "Mei Member", role: "member", orgSlug: "acme" },
  { email: "viewer@acme.test", name: "Victor Viewer", role: "viewer", orgSlug: "acme" },
  { email: "owner@globex.test", name: "Grace Globex", role: "owner", orgSlug: "globex" },
]

type Sql = ReturnType<typeof postgres>

async function insertOrg(sql: Sql, slug: string): Promise<string> {
  const [row] = await sql<Array<{ id: string }>>`
    insert into organizations (slug, name, plan)
    values (${slug}, ${slug.toUpperCase()}, 'team')
    on conflict (slug) do update set name = excluded.name
    returning id
  `
  return row!.id
}

async function insertUser(sql: Sql, user: SeedUser, orgId: string, passwordHash: string): Promise<void> {
  await sql`
    insert into users (email, name, password_hash, mfa_secret)
    values (${user.email}, ${user.name}, ${passwordHash}, ${user.mfaEnabled ? "TESTMFASECRET234" : null})
    on conflict (email) do nothing
  `
  await sql`
    insert into memberships (user_id, org_id, role)
    select id, ${orgId}, ${user.role} from users where email = ${user.email}
    on conflict do nothing
  `
}

export async function seed(sql: Sql = postgres(TEST_DATABASE_URL)): Promise<Map<string, any>> {
  // await sql`truncate users, memberships, organizations restart identity cascade`
  const passwordHash = await hash(TEST_PASSWORD)
  const orgIds = new Map<string, string>()
  for (const slug of new Set(seedUsers.map((user) => user.orgSlug))) {
    orgIds.set(slug, await insertOrg(sql, slug))
  }
  for (const user of seedUsers) {
    insertUser(sql, user, orgIds.get(user.orgSlug)!, passwordHash)
  }
  const rows = await sql`select id, email, name from users where email like '%.test'`
  return new Map(rows.map((row) => [row.email as string, row]))
}
