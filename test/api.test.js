import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

async function waitForHealth(baseUrl) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error("Server did not become healthy.");
}

function killChildAndWait(child, timeoutMs = 3000) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill();
  });
}

let nextTestPort = 3900 + Math.floor(Math.random() * 300);

async function startServer(extraEnv = {}) {
  const tempDir = await mkdtemp(join(tmpdir(), "ag-crm-test-"));
  const port = nextTestPort++;
  const child = spawn(process.execPath, ["src/server.js"], {
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: tempDir,
      DATA_FILE: join(tempDir, "crm.json"),
      SECRETS_FILE: join(tempDir, "secrets.json"),
      LLM_API_KEY: "",
      ...extraEnv
    },
    stdio: "ignore"
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHealth(baseUrl);
  return {
    baseUrl,
    tempDir,
    async stop() {
      await killChildAndWait(child);
      await rm(tempDir, { recursive: true, force: true });
    }
  };
}

async function startMockServer(handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

test("contact upsert creates, deduplicates, and supports child records", async () => {
  const server = await startServer();
  try {
    const first = await fetch(`${server.baseUrl}/api/contacts/upsert`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        org_id: "org_default",
        actor_type: "extension",
        source: { url: "https://example.com/team", domain: "example.com" },
        contact: {
          name: "Ahmed Example",
          company_name: "Example Co",
          title: "Founder",
          emails: ["Ahmed@Example.com"],
          phones: ["+966 555 000 000"],
          tags: ["prospect"],
          note: "Captured from website."
        }
      })
    });
    assert.equal(first.status, 200);
    const created = await first.json();
    assert.equal(created.status, "created");
    assert.ok(created.contact_id);

    const second = await fetch(`${server.baseUrl}/api/contacts/upsert`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        org_id: "org_default",
        actor_type: "human",
        contact: {
          name: "Ahmed Updated",
          emails: ["ahmed@example.com"],
          tags: ["referral"]
        }
      })
    });
    assert.equal(second.status, 200);
    const updated = await second.json();
    assert.equal(updated.status, "updated");
    assert.equal(updated.contact_id, created.contact_id);

    const note = await fetch(`${server.baseUrl}/api/notes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        org_id: "org_default",
        actor_type: "human",
        contact_id: created.contact_id,
        body: "Followed up."
      })
    });
    assert.equal(note.status, 201);

    const edit = await fetch(`${server.baseUrl}/api/contacts/${created.contact_id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        org_id: "org_default",
        actor_type: "human",
        source: {
          url: "https://directory.example.com/profile/abc",
          domain: "directory.example.com",
          platform: "Example Directory"
        },
        contact: {
          name: "Ahmed Edited",
          company_name: "Seven Pyramids Trading",
          title: "Regional Sales Manager",
          emails: ["edited@example.com"],
          phones: ["+966 555 222 333"],
          website: "https://sevenpyramids.example",
          address: "Riyadh, Example Tower Level 18",
          tags: ["prospect", "corrected"]
        }
      })
    });
    assert.equal(edit.status, 200);

    const detail = await fetch(`${server.baseUrl}/api/contacts/${created.contact_id}`);
    const body = await detail.json();
    assert.equal(body.contact.name, "Ahmed Edited");
    assert.equal(body.contact.company.name, "Seven Pyramids Trading");
    assert.equal(body.contact.title, "Regional Sales Manager");
    assert.equal(body.contact.website, "https://sevenpyramids.example");
    assert.match(body.contact.address, /Example Tower Level 18/i);
    assert.deepEqual(body.contact.emails, ["edited@example.com"]);
    assert.deepEqual(body.contact.phones, ["+966555222333"]);
    assert.equal(body.contact.notes.length, 2);
    assert.ok(body.contact.tags.includes("prospect"));
    assert.ok(body.contact.tags.includes("corrected"));
    assert.equal(body.contact.source.platform, "Example Directory");
  } finally {
    await server.stop();
  }
});

test("contact match finds existing source URL and email duplicates", async () => {
  const server = await startServer();
  try {
    const created = await fetch(`${server.baseUrl}/api/contacts/upsert`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        org_id: "org_default",
        actor_type: "extension",
        source: { url: "https://directory.example.com/profile/existing", domain: "directory.example.com" },
        contact: {
          name: "Existing Lead",
          emails: ["existing@example.com"],
          phones: ["+966555111222"]
        }
      })
    });
    const createdBody = await created.json();
    assert.ok(createdBody.contact_id);

    const match = await fetch(
      `${server.baseUrl}/api/contacts/match?source_url=${encodeURIComponent("https://directory.example.com/profile/existing")}&emails=existing@example.com`
    );
    const matchBody = await match.json();
    assert.equal(match.status, 200);
    assert.equal(matchBody.exists, true);
    assert.equal(matchBody.best_match.contact.id, createdBody.contact_id);
    assert.equal(matchBody.best_match.match_type, "source_url");
  } finally {
    await server.stop();
  }
});

async function runExtractLead(context) {
  const source = await readFile("extension/extract-lead.js", "utf8");
  const wrapped = `${source}\nwindow.AG_CRM.extractLead();`;
  return new vm.Script(wrapped).runInContext(context);
}

test("extension extraction separates profile company from source platform", async () => {
  const context = vm.createContext({
    window: {
      AG_CRM: {},
      location: {
        hostname: "directory.example.com",
        href: "https://directory.example.com/profile/abc"
      }
    },
    document: {
      title: "Jordan Rivers - Example Directory",
      body: {
        innerText: [
          "Jordan Rivers",
          "Regional Sales Manager at NORTHWIND TRADING",
          "Riyadh, Saudi Arabia",
          "+966 *5318 show number"
        ].join("\n")
      },
      querySelector(selector) {
        if (selector === "h1") return { innerText: "Jordan Rivers" };
        if (selector === 'meta[property="og:site_name"]') return { content: "Example Directory" };
        return null;
      },
      querySelectorAll(selector) {
        if (selector === 'script[type="application/ld+json"]') return [];
        if (selector === "a[href]") return [];
        return [];
      }
    }
  });
  context.window.window = context.window;
  const result = await runExtractLead(context);
  assert.equal(result.name, "Jordan Rivers");
  assert.equal(result.title, "Regional Sales Manager");
  assert.equal(result.company_name, "NORTHWIND TRADING");
  assert.equal(result.source.domain, "directory.example.com");
  assert.equal(result.source.platform, "Example Directory");
  assert.deepEqual([...result.tags], []);
  assert.deepEqual([...result.phones], []);
  assert.equal(result.phone_reveal_available, true);
});

test("extension extraction prefers profile company over unrelated page matches", async () => {
  const context = vm.createContext({
    window: {
      AG_CRM: {},
      location: {
        hostname: "directory.example.com",
        href: "https://directory.example.com/profile/sam-carter"
      }
    },
    document: {
      title: "Sam Carter - Example Directory",
      body: {
        innerText: [
          "Managing Director at Contoso K.K.",
          "Sam Carter",
          "at Carter and Partners",
          "Riyadh, Saudi Arabia",
          "+966 *00966110000000 show number",
          "Riyadh, Example Tower Level 18",
          "carterpartners-example.com",
          "Connect"
        ].join("\n")
      },
      querySelector(selector) {
        if (selector === "h1") {
          return {
            innerText: "Sam Carter",
            nextElementSibling: {
              innerText: "at Carter and Partners",
              nextElementSibling: { innerText: "Riyadh, Saudi Arabia", nextElementSibling: null }
            },
            closest() {
              return {
                querySelectorAll() {
                  return [
                    {
                      getAttribute: () => "https://example.com/company",
                      innerText: "Carter and Partners"
                    }
                  ];
                }
              };
            },
            parentElement: null
          };
        }
        if (selector === 'meta[property="og:site_name"]') return { content: "Example Directory" };
        return null;
      },
      querySelectorAll(selector) {
        if (selector === 'script[type="application/ld+json"]') return [];
        if (selector === "a[href]") {
          return [
            {
              getAttribute: () => "https://carterpartners-example.com",
              innerText: "carterpartners-example.com"
            }
          ];
        }
        return [];
      }
    }
  });
  context.window.window = context.window;
  const result = await runExtractLead(context);
  assert.equal(result.name, "Sam Carter");
  assert.equal(result.company_name, "Carter and Partners");
  assert.notEqual(result.company_name, "Contoso K.K.");
  assert.equal(result.website, "https://carterpartners-example.com");
  assert.match(result.address, /Example Tower Level 18/i);
  assert.equal(result.phone_reveal_available, true);
});

test("scraper upsert marks contact pending review and supports confirm endpoint", async () => {
  const server = await startServer();
  try {
    const created = await fetch(`${server.baseUrl}/api/contacts/upsert`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        org_id: "org_default",
        actor_type: "scraper",
        source: { url: "https://directory.example.com/business/test-review", domain: "directory.example.com" },
        capture_metadata: {
          validation_warnings: ["Company replaced \"Contoso K.K.\" with listing \"Carter and Partners\""]
        },
        contact: {
          name: "Sam Carter",
          company_name: "Carter and Partners",
          phones: ["+966555111222"]
        }
      })
    });
    assert.equal(created.status, 200);
    const body = await created.json();
    assert.ok(body.contact_id);

    const detail = await fetch(`${server.baseUrl}/api/contacts/${body.contact_id}`);
    const contactBody = await detail.json();
    assert.equal(contactBody.contact.data_review_status, "pending");
    assert.equal(contactBody.contact.capture_metadata.validation_warnings.length, 1);

    const pendingList = await fetch(`${server.baseUrl}/api/contacts?review_status=pending`);
    const pendingBody = await pendingList.json();
    assert.ok(pendingBody.contacts.some((item) => item.id === body.contact_id));

    const review = await fetch(`${server.baseUrl}/api/contacts/${body.contact_id}/review`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ org_id: "org_default", actor_type: "human", status: "confirmed" })
    });
    assert.equal(review.status, 200);
    const reviewed = await review.json();
    assert.equal(reviewed.data_review_status, "confirmed");
    assert.ok(reviewed.contact.data_reviewed_at);
  } finally {
    await server.stop();
  }
});

test("scraper upsert stores city from capture context and supports city sort", async () => {
  const server = await startServer();
  try {
    const created = await fetch(`${server.baseUrl}/api/contacts/upsert`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        org_id: "org_default",
        actor_type: "scraper",
        source: { url: "https://directory.example.com/people/3324", domain: "directory.example.com", platform: "Example Directory" },
        contact: {
          name: "سارة أحمد",
          company_name: "شركة المثال",
          emails: ["info@example.com"],
          capture_metadata: {
            capture_context: { city: "الرياض", directory_id: "3324" }
          }
        }
      })
    });
    assert.equal(created.status, 200);
    const body = await created.json();
    const detail = await fetch(`${server.baseUrl}/api/contacts/${body.contact_id}`);
    const contactBody = await detail.json();
    assert.equal(contactBody.contact.city, "الرياض");

    const sorted = await fetch(`${server.baseUrl}/api/contacts?sort_by=city&record_kind=person`);
    const sortedBody = await sorted.json();
    assert.ok(sortedBody.contacts.some((item) => item.id === body.contact_id && item.city === "الرياض"));
  } finally {
    await server.stop();
  }
});

test("upsert matches existing contact by profile UUID across URL shapes", async () => {
  const server = await startServer();
  try {
    const created = await fetch(`${server.baseUrl}/api/contacts/upsert`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        org_id: "org_default",
        actor_type: "extension",
        source: { url: "https://directory.example.com/profile/01d28e4b-9acb-e711-80ce-000d3aa1e60f", domain: "directory.example.com" },
        contact: {
          name: "Sam Carter",
          company_name: "Contoso K.K.",
          title: "Managing Director"
        }
      })
    });
    const first = await created.json();
    assert.equal(first.status, "created");

    const updated = await fetch(`${server.baseUrl}/api/contacts/upsert`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        org_id: "org_default",
        actor_type: "scraper",
        source: {
          url: "https://directory.example.com/business/01d28e4b-9acb-e711-80ce-000d3aa1e60f",
          domain: "directory.example.com"
        },
        capture_metadata: { capture_context: { person_name: "Sam Carter", company_name: "Carter and Partners" } },
        contact: {
          name: "Sam Carter",
          company_name: "Carter and Partners",
          title: "Managing Director"
        }
      })
    });
    const second = await updated.json();
    assert.equal(second.status, "updated");
    assert.equal(second.contact_id, first.contact_id);

    const detail = await fetch(`${server.baseUrl}/api/contacts/${first.contact_id}`);
    const body = await detail.json();
    assert.equal(body.contact.company.name, "Carter and Partners");
    assert.equal(body.contact.data_review_status, "pending");
  } finally {
    await server.stop();
  }
});

test("contact delete soft-removes a single contact", async () => {
  const server = await startServer();
  try {
    const created = await fetch(`${server.baseUrl}/api/contacts/upsert`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        org_id: "org_default",
        actor_type: "extension",
        contact: { name: "Delete Me", emails: ["delete-me@example.com"] }
      })
    });
    const { contact_id: contactId } = await created.json();
    const deleted = await fetch(`${server.baseUrl}/api/contacts/${contactId}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ org_id: "org_default", actor_type: "extension" })
    });
    assert.equal(deleted.status, 200);

    const list = await fetch(`${server.baseUrl}/api/contacts`);
    const body = await list.json();
    assert.equal(
      body.contacts.some((contact) => contact.id === contactId),
      false
    );
  } finally {
    await server.stop();
  }
});

test("bulk delete archives selected contacts", async () => {
  const server = await startServer();
  try {
    const ids = [];
    for (const email of ["bulk-a@example.com", "bulk-b@example.com", "bulk-c@example.com"]) {
      const created = await fetch(`${server.baseUrl}/api/contacts/upsert`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          org_id: "org_default",
          actor_type: "extension",
          contact: { name: email.split("@")[0], emails: [email] }
        })
      });
      const body = await created.json();
      ids.push(body.contact_id);
    }

    const deleted = await fetch(`${server.baseUrl}/api/contacts/bulk-delete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        org_id: "org_default",
        actor_type: "human",
        contact_ids: [ids[0], ids[2]]
      })
    });
    assert.equal(deleted.status, 200);
    const deleteBody = await deleted.json();
    assert.equal(deleteBody.deleted, 2);

    const list = await fetch(`${server.baseUrl}/api/contacts`);
    const body = await list.json();
    const activeIds = body.contacts.map((contact) => contact.id);
    assert.equal(activeIds.includes(ids[0]), false);
    assert.equal(activeIds.includes(ids[1]), true);
    assert.equal(activeIds.includes(ids[2]), false);
  } finally {
    await server.stop();
  }
});

test("contact dedupe merges same profile records", async () => {
  const server = await startServer();
  try {
    const profileUrl =
      "https://directory.example.com/companies/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const altUrl = "https://directory.example.com/business/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

    for (const [index, url] of [profileUrl, altUrl].entries()) {
      const response = await fetch(`${server.baseUrl}/api/contacts/upsert`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          org_id: "org_default",
          actor_type: "scraper",
          source: { url, domain: "directory.example.com" },
          contact: {
            name: "Duplicate Person",
            emails: [`dup${index}@example.com`],
            phones: [`+96650000000${index}`]
          }
        })
      });
      assert.equal(response.status, 200);
    }

    const list = await fetch(`${server.baseUrl}/api/contacts`);
    const body = await list.json();
    const matches = body.contacts.filter((contact) =>
      contact.emails.some((email) => email.startsWith("dup"))
    );
    assert.equal(matches.length, 1);
    assert.ok(matches[0].emails.length >= 2);
  } finally {
    await server.stop();
  }
});

test("contact match finds profile UUID across URL shapes", async () => {
  const server = await startServer();
  try {
    const created = await fetch(`${server.baseUrl}/api/contacts/upsert`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        org_id: "org_default",
        actor_type: "extension",
        source: {
          url: "https://directory.example.com/companies/bbbbcccc-dddd-eeee-ffff-000011112222",
          domain: "directory.example.com"
        },
        contact: { name: "Profile Match Test", emails: ["profile-match@example.com"] }
      })
    });
    assert.equal(created.status, 200);

    const match = await fetch(
      `${server.baseUrl}/api/contacts/match?org_id=org_default&source_url=${encodeURIComponent(
        "https://directory.example.com/business/bbbbcccc-dddd-eeee-ffff-000011112222"
      )}`
    );
    const body = await match.json();
    assert.equal(body.exists, true);
    assert.equal(body.best_match.match_type, "profile_id");
  } finally {
    await server.stop();
  }
});

test("contact match ignores profile UUID when person lead matches company contact", async () => {
  const server = await startServer();
  const profileId = "ccccdddd-eeee-ffff-0000-111122223333";
  try {
    await fetch(`${server.baseUrl}/api/contacts/upsert`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        org_id: "org_default",
        actor_type: "scraper",
        source: {
          url: `https://directory.example.com/business/${profileId}`,
          domain: "directory.example.com"
        },
        contact: {
          name: "Bloomberg L.P",
          company_name: "Bloomberg L.P - Saudi Arabia Branch"
        }
      })
    });

    const match = await fetch(
      `${server.baseUrl}/api/contacts/match?org_id=org_default&source_url=${encodeURIComponent(
        `https://directory.example.com/business/${profileId}`
      )}&name=${encodeURIComponent("Jeffrey Vause")}&person_name=${encodeURIComponent(
        "Jeffrey Vause"
      )}&company_name=${encodeURIComponent("Bloomberg L.P - Saudi Arabia Branch")}&capture_metadata=${encodeURIComponent(
        JSON.stringify({
          capture_context: {
            listing_tab: "people",
            person_name: "Jeffrey Vause",
            company_name: "Bloomberg L.P - Saudi Arabia Branch"
          }
        })
      )}`
    );
    const body = await match.json();
    assert.equal(body.exists, false);
  } finally {
    await server.stop();
  }
});

test("upsert creates separate person contact when company already exists on same profile UUID", async () => {
  const server = await startServer();
  const profileId = "ddddeeee-ffff-0000-1111-222233334444";
  try {
    const company = await fetch(`${server.baseUrl}/api/contacts/upsert`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        org_id: "org_default",
        actor_type: "scraper",
        source: {
          url: `https://directory.example.com/business/${profileId}`,
          domain: "directory.example.com"
        },
        contact: {
          name: "Bloomberg L.P",
          company_name: "Bloomberg L.P - Saudi Arabia Branch",
          phones: ["12126172396"]
        }
      })
    });
    const companyBody = await company.json();
    assert.equal(companyBody.status, "created");

    const person = await fetch(`${server.baseUrl}/api/contacts/upsert`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        org_id: "org_default",
        actor_type: "extension",
        source: {
          url: `https://directory.example.com/business/${profileId}`,
          domain: "directory.example.com"
        },
        capture_metadata: {
          capture_context: {
            listing_tab: "people",
            person_name: "Jeffrey Vause",
            company_name: "Bloomberg L.P - Saudi Arabia Branch"
          }
        },
        contact: {
          name: "Jeffrey Vause",
          company_name: "Bloomberg L.P - Saudi Arabia Branch",
          phones: ["12126172396"]
        }
      })
    });
    const personBody = await person.json();
    assert.equal(personBody.status, "created");
    assert.notEqual(personBody.contact_id, companyBody.contact_id);

    const list = await fetch(`${server.baseUrl}/api/contacts`);
    const listBody = await list.json();
    const names = listBody.contacts
      .filter((contact) => [companyBody.contact_id, personBody.contact_id].includes(contact.id))
      .map((contact) => contact.name)
      .sort();
    assert.deepEqual(names, ["Bloomberg L.P", "Jeffrey Vause"]);
  } finally {
    await server.stop();
  }
});

test("restore deleted contacts brings archived records back", async () => {
  const server = await startServer();
  try {
    const created = await fetch(`${server.baseUrl}/api/contacts/upsert`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        org_id: "org_default",
        actor_type: "scraper",
        contact: { name: "Archived Lead", emails: ["archived@example.com"] }
      })
    });
    const { contact_id: contactId } = await created.json();
    const deleted = await fetch(`${server.baseUrl}/api/contacts/${contactId}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ org_id: "org_default", actor_type: "human" })
    });
    assert.equal(deleted.status, 200);

    const hidden = await fetch(`${server.baseUrl}/api/contacts`);
    const hiddenBody = await hidden.json();
    assert.equal(hiddenBody.contacts.some((contact) => contact.id === contactId), false);

    const restored = await fetch(`${server.baseUrl}/api/contacts/restore-deleted`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ org_id: "org_default", actor_type: "human", scope: "all" })
    });
    assert.equal(restored.status, 200);

    const visible = await fetch(`${server.baseUrl}/api/contacts`);
    const visibleBody = await visible.json();
    assert.equal(visibleBody.contacts.some((contact) => contact.id === contactId), true);
  } finally {
    await server.stop();
  }
});

test("contact file upload stores brochure attachment", async () => {
  const server = await startServer();
  try {
    const created = await fetch(`${server.baseUrl}/api/contacts/upsert`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        org_id: "org_default",
        actor_type: "human",
        contact: { name: "Attachment Test", company_name: "Example Co" }
      })
    });
    const { contact_id: contactId } = await created.json();
    const pdfBytes = Buffer.from("%PDF-1.4 test brochure");
    const upload = await fetch(`${server.baseUrl}/api/contacts/${contactId}/files`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        org_id: "org_default",
        actor_type: "scraper",
        filename: "brochure.pdf",
        mime_type: "application/pdf",
        kind: "brochure",
        source_url: "https://directory.example.com/files/brochure.pdf",
        content_base64: pdfBytes.toString("base64")
      })
    });
    assert.equal(upload.status, 201);
    const uploadBody = await upload.json();
    assert.ok(uploadBody.file?.id);

    const detail = await fetch(`${server.baseUrl}/api/contacts/${contactId}`);
    const contactBody = await detail.json();
    assert.equal(contactBody.contact.files.length, 1);
    assert.equal(contactBody.contact.files[0].filename, "brochure.pdf");

    const download = await fetch(`${server.baseUrl}/api/files/${uploadBody.file.id}/download`);
    assert.equal(download.status, 200);
    const downloaded = Buffer.from(await download.arrayBuffer());
    assert.equal(downloaded.toString("utf8"), "%PDF-1.4 test brochure");
  } finally {
    await server.stop();
  }
});

test("contact list filters people and company profiles by record_kind", async () => {
  const server = await startServer();
  try {
    await fetch(`${server.baseUrl}/api/contacts/upsert`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        org_id: "org_default",
        actor_type: "scraper",
        source: {
          url: "https://directory.example.com/business/ffff0000-1111-2222-3333-444455556666",
          domain: "directory.example.com"
        },
        capture_metadata: { profile_page_type: "business" },
        contact: {
          name: "Example Corp L.P",
          company_name: "Example Corp L.P - Riyadh Branch",
          phones: ["+966500000001"]
        }
      })
    });
    await fetch(`${server.baseUrl}/api/contacts/upsert`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        org_id: "org_default",
        actor_type: "extension",
        source: {
          url: "https://directory.example.com/profile/ffff0000-1111-2222-3333-444455556666",
          domain: "directory.example.com"
        },
        capture_metadata: {
          capture_context: {
            listing_tab: "people",
            person_name: "Jane Example"
          }
        },
        contact: {
          name: "Jane Example",
          company_name: "Example Corp L.P - Riyadh Branch",
          phones: ["+966500000002"]
        }
      })
    });
    await fetch(`${server.baseUrl}/api/contacts/upsert`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        org_id: "org_default",
        actor_type: "scraper",
        capture_metadata: {
          profile_page_type: "business",
          capture_context: {
            listing_tab: "people",
            person_name: "Jane Example",
            company_profile_url:
              "https://directory.example.com/companies/ffff0000-1111-2222-3333-444455556666"
          }
        },
        contact: {
          name: "Example Corp L.P",
          company_name: "Example Corp L.P - Riyadh Branch"
        }
      })
    });

    const people = await fetch(`${server.baseUrl}/api/contacts?record_kind=person`);
    const companies = await fetch(`${server.baseUrl}/api/contacts?record_kind=company`);
    const peopleBody = await people.json();
    const companiesBody = await companies.json();
    assert.equal(
      peopleBody.contacts.some((contact) => contact.name === "Jane Example"),
      true
    );
    assert.equal(
      peopleBody.contacts.some((contact) => contact.name === "Example Corp L.P"),
      false
    );
    assert.equal(
      companiesBody.contacts.some((contact) => contact.name === "Example Corp L.P"),
      true
    );
    assert.equal(
      companiesBody.contacts.some((contact) => contact.name === "Jane Example"),
      false
    );
  } finally {
    await server.stop();
  }
});

test("dedupe merges duplicate people sharing capture profile metadata", async () => {
  const server = await startServer();
  const profileId = "aaaa1111-bbbb-2222-3333-444455556666";
  const profileUrl = `https://directory.example.com/companies/${profileId}`;
  try {
    for (const stamp of ["first", "second"]) {
      await fetch(`${server.baseUrl}/api/contacts/upsert`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          org_id: "org_default",
          actor_type: "scraper",
          capture_metadata: {
            profile_page_type: "business",
            capture_context: {
              listing_tab: "people",
              person_name: "Jeffrey Vause",
              company_profile_url: profileUrl
            }
          },
          contact: {
            name: "Jeffrey Vause",
            company_name: "Bloomberg L.P - Saudi Arabia Branch",
            phones: ["12126172396"]
          }
        })
      });
    }

    const dedupe = await fetch(`${server.baseUrl}/api/contacts/dedupe`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ org_id: "org_default", actor_type: "human" })
    });
    await dedupe.json();

    const people = await fetch(`${server.baseUrl}/api/contacts?record_kind=person`);
    const peopleBody = await people.json();
    const jeffrey = peopleBody.contacts.filter((contact) => contact.name === "Jeffrey Vause");
    assert.equal(jeffrey.length, 1);
  } finally {
    await server.stop();
  }
});

test("dedupe keeps different people separate on the same company profile UUID", async () => {
  const server = await startServer();
  const profileId = "bbbb2222-cccc-3333-4444-555566667777";
  const profileUrl = `https://directory.example.com/companies/${profileId}`;
  try {
    for (const person of ["Jeffrey Vause", "Jane Colleague"]) {
      await fetch(`${server.baseUrl}/api/contacts/upsert`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          org_id: "org_default",
          actor_type: "scraper",
          capture_metadata: {
            profile_page_type: "business",
            capture_context: {
              listing_tab: "people",
              person_name: person,
              company_profile_url: profileUrl
            }
          },
          contact: {
            name: person,
            company_name: "Shared Company L.P - Riyadh Branch"
          }
        })
      });
    }

    await fetch(`${server.baseUrl}/api/contacts/dedupe`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ org_id: "org_default", actor_type: "human" })
    });

    const people = await fetch(`${server.baseUrl}/api/contacts?record_kind=person`);
    const peopleBody = await people.json();
    assert.equal(
      peopleBody.contacts.filter((contact) => contact.name === "Jeffrey Vause").length,
      1
    );
    assert.equal(
      peopleBody.contacts.filter((contact) => contact.name === "Jane Colleague").length,
      1
    );
  } finally {
    await server.stop();
  }
});

test("extension reveal script clicks nearest visible show-number control", async () => {
  const source = await readFile("extension/reveal.js", "utf8");
  const clicks = [];

  class FakeMouseEvent {
    constructor(type) {
      this.type = type;
    }
  }

  function createElement({ text = "", tagName = "span", parentElement = null, cursor = "auto", attrs = [] } = {}) {
    const element = {
      innerText: text,
      textContent: text,
      tagName,
      parentElement,
      children: [],
      classList: { contains: () => false },
      getAttribute(name) {
        if (name === "role" && attrs.includes("role=button")) return "button";
        return null;
      },
      hasAttribute(name) {
        return attrs.includes(name);
      },
      getBoundingClientRect() {
        return { width: 80, height: 20 };
      },
      scrollIntoView() {},
      focus() {},
      dispatchEvent(event) {
        clicks.push(`${tagName}:${event.type}`);
      },
      click() {
        clicks.push(`${tagName}:native-click`);
      },
      _cursor: cursor
    };
    if (parentElement) parentElement.children.push(element);
    return element;
  }

  const body = createElement({ tagName: "body" });
  const clickable = createElement({ text: "+966 *5318 show number", tagName: "div", parentElement: body, cursor: "pointer" });
  const nested = createElement({ text: "show number", tagName: "span", parentElement: clickable });
  const context = vm.createContext({
    window: {
      MouseEvent: FakeMouseEvent,
      getComputedStyle(element) {
        return {
          visibility: "visible",
          display: "block",
          pointerEvents: "auto",
          cursor: element._cursor || "auto"
        };
      }
    },
    document: {
      body: {
        querySelectorAll() {
          return [body, clickable, nested];
        }
      }
    }
  });
  context.window.window = context.window;
  const result = new vm.Script(source).runInContext(context);
  assert.equal(result.clicked, 1);
  assert.equal(result.matched, 1);
  assert.ok(clicks.includes("div:click"));
  assert.ok(clicks.includes("div:native-click"));
});

test("AI extract endpoint parses mocked OpenRouter leads and normalizes fields", async () => {
  const llmResponse = {
    id: "gen-1",
    model: "z-ai/glm-5.2",
    choices: [
      {
        message: {
          role: "assistant",
          content: JSON.stringify({
            leads: [
              {
                name: "محمد الغامدي",
                company_name: "مكتب الغامدي للمحاماة",
                title: "محامي",
                emails: ["Info@Example-Law.com", "info@example-law.com"],
                phones: ["+966 55 123 4567"],
                website: "https://example-law.com",
                city: "الرياض",
                record_kind: "person",
                confidence: 0.95
              },
              { name: "", company_name: "", emails: [], phones: [] },
              {
                company_name: "Blue Ocean Trading",
                emails: ["sales@blueocean.example"],
                record_kind: "company",
                confidence: 0.7
              }
            ]
          })
        }
      }
    ],
    usage: { prompt_tokens: 100, completion_tokens: 50 }
  };
  const mockLlm = await startMockServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(llmResponse));
  });
  const server = await startServer({
    LLM_BASE_URL: mockLlm.url,
    LLM_API_KEY: "test-key"
  });
  try {
    const response = await fetch(`${server.baseUrl}/api/extract/ai`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: "https://directory.example/page",
        title: "Team directory",
        page_text: "محمد الغامدي محامي الرياض info@example-law.com +966551234567"
      })
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, "ok");
    assert.equal(body.leads.length, 2);

    const person = body.leads[0];
    assert.equal(person.name, "محمد الغامدي");
    assert.deepEqual(person.emails, ["info@example-law.com"]);
    assert.deepEqual(person.phones, ["+966551234567"]);
    assert.equal(person.city, "الرياض");
    assert.equal(person.record_kind, "person");

    const company = body.leads[1];
    assert.equal(company.company_name, "Blue Ocean Trading");
    assert.equal(company.record_kind, "company");
  } finally {
    await server.stop();
    await mockLlm.close();
  }
});

test("AI extract endpoint fails cleanly when no API key configured", async () => {
  const server = await startServer();
  try {
    const response = await fetch(`${server.baseUrl}/api/extract/ai`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.com", page_text: "Some page text" })
    });
    assert.equal(response.status, 502);
    const body = await response.json();
    assert.equal(body.status, "llm_failed");
    assert.match(body.error, /api key/i);
  } finally {
    await server.stop();
  }
});

test("AI-extracted lead upsert stores city, record_kind and llm capture metadata", async () => {
  const server = await startServer();
  try {
    const response = await fetch(`${server.baseUrl}/api/contacts/upsert`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        org_id: "org_default",
        actor_type: "extension",
        data_review_status: "pending",
        source: { url: "https://somewhere.example/team", domain: "somewhere.example" },
        contact: {
          name: "Layla Example",
          title: "Partner",
          emails: ["layla@somewhere.example"],
          city: "جدة",
          record_kind: "person",
          capture_metadata: {
            extractor: "llm",
            llm_model: "z-ai/glm-5.2",
            llm_confidence: 0.9
          }
        }
      })
    });
    assert.equal(response.status, 200);
    const created = await response.json();
    assert.equal(created.status, "created");

    const detail = await fetch(`${server.baseUrl}/api/contacts/${created.contact_id}`).then((r) => r.json());
    assert.equal(detail.contact.city, "جدة");
    assert.equal(detail.contact.record_kind, "person");
    assert.equal(detail.contact.capture_metadata.extractor, "llm");
    assert.equal(detail.contact.data_review_status, "pending");
  } finally {
    await server.stop();
  }
});

test("GoHighLevel push maps contacts, handles per-contact errors, and requires config", async () => {
  const ghlRequests = [];
  const mockGhl = await startMockServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    ghlRequests.push({ url: req.url, auth: req.headers.authorization, version: req.headers.version, body });
    if (body.email === "fails@example.com") {
      res.writeHead(422, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "Invalid contact payload." }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ new: true, contact: { id: `ghl-${body.email || body.phone}` } }));
  });
  const server = await startServer({ GHL_BASE_URL: mockGhl.url });
  try {
    const notConfigured = await fetch(`${server.baseUrl}/api/integrations/gohighlevel/push`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ contact_ids: ["missing"] })
    });
    assert.equal(notConfigured.status, 422);
    assert.equal((await notConfigured.json()).status, "not_configured");

    const saveSettings = await fetch(`${server.baseUrl}/api/integrations/gohighlevel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ private_integration_token: "pit-test-token", default_location_id: "loc_123" })
    });
    assert.equal(saveSettings.status, 200);
    const settings = await saveSettings.json();
    assert.equal(settings.configured, true);
    assert.equal(settings.default_location_id, "loc_123");
    assert.ok(!settings.token_preview.includes("pit-test-token"));

    const contactIds = [];
    for (const contact of [
      { name: "Good Lead", emails: ["good@example.com"], city: "الرياض", company_name: "Good Co" },
      { name: "Bad Lead", emails: ["fails@example.com"] },
      { name: "No Contact Info Lead", emails: [], phones: [] }
    ]) {
      const created = await fetch(`${server.baseUrl}/api/contacts/upsert`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ org_id: "org_default", actor_type: "human", contact })
      }).then((r) => r.json());
      contactIds.push(created.contact_id);
    }

    const push = await fetch(`${server.baseUrl}/api/integrations/gohighlevel/push`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ org_id: "org_default", contact_ids: contactIds })
    });
    assert.equal(push.status, 200);
    const result = await push.json();
    assert.equal(result.location_id, "loc_123");
    assert.equal(result.summary.pushed, 1);
    assert.equal(result.summary.failed, 1);
    assert.equal(result.summary.skipped, 1);

    const good = result.results.find((row) => row.name === "Good Lead");
    assert.equal(good.status, "created");
    assert.equal(good.ghl_contact_id, "ghl-good@example.com");
    const bad = result.results.find((row) => row.name === "Bad Lead");
    assert.equal(bad.status, "failed");
    assert.match(bad.error, /Invalid contact payload/);
    const skipped = result.results.find((row) => row.name === "No Contact Info Lead");
    assert.equal(skipped.status, "skipped");

    const upsertCall = ghlRequests.find((row) => row.body.email === "good@example.com");
    assert.equal(upsertCall.url, "/contacts/upsert");
    assert.equal(upsertCall.auth, "Bearer pit-test-token");
    assert.equal(upsertCall.body.locationId, "loc_123");
    assert.equal(upsertCall.body.firstName, "Good");
    assert.equal(upsertCall.body.lastName, "Lead");
    assert.equal(upsertCall.body.city, "الرياض");
    assert.equal(upsertCall.body.companyName, "Good Co");
    assert.ok(upsertCall.body.tags.includes("ag-crm"));
  } finally {
    await server.stop();
    await mockGhl.close();
  }
});

test("structured contact query filters by city, empty website, and name prefix", async () => {
  const server = await startServer();
  try {
    for (const contact of [
      { name: "Amal Riyadh NoSite", city: "الرياض", emails: ["amal@r.example"] },
      { name: "Amal Riyadh WithSite", city: "الرياض", website: "https://has-site.example", emails: ["amal2@r.example"] },
      { name: "Badr Riyadh NoSite", city: "الرياض", emails: ["badr@r.example"] },
      { name: "Amal Jeddah NoSite", city: "جدة", emails: ["amal@j.example"] }
    ]) {
      await fetch(`${server.baseUrl}/api/contacts/upsert`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ org_id: "org_default", actor_type: "human", contact })
      });
    }

    const allMatch = await fetch(`${server.baseUrl}/api/contacts/query`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        match: "all",
        filters: [
          { field: "city", op: "eq", value: "الرياض" },
          { field: "website", op: "empty" },
          { field: "name", op: "starts_with", value: "Amal" }
        ],
        sort_by: "name"
      })
    });
    assert.equal(allMatch.status, 200);
    const allBody = await allMatch.json();
    assert.equal(allBody.total, 1);
    assert.equal(allBody.contacts[0].name, "Amal Riyadh NoSite");

    const anyMatch = await fetch(`${server.baseUrl}/api/contacts/query`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        match: "any",
        filters: [
          { field: "city", op: "eq", value: "جدة" },
          { field: "website", op: "not_empty" }
        ]
      })
    });
    const anyBody = await anyMatch.json();
    assert.equal(anyBody.total, 2);

    const invalid = await fetch(`${server.baseUrl}/api/contacts/query`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ filters: [{ field: "nope", op: "wat" }] })
    });
    assert.equal(invalid.status, 422);
    const invalidBody = await invalid.json();
    assert.equal(invalidBody.status, "validation_failed");
    assert.ok(invalidBody.errors.length >= 2);
  } finally {
    await server.stop();
  }
});

test("LLM config can come from environment (as populated by the .env loader)", async () => {
  const llmResponse = {
    model: "env-model",
    choices: [{ message: { content: JSON.stringify({ leads: [{ name: "Env Lead", emails: ["env@lead.example"] }] }) } }]
  };
  const mockLlm = await startMockServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(llmResponse));
  });
  const server = await startServer({
    LLM_BASE_URL: mockLlm.url,
    LLM_API_KEY: "key-via-env"
  });
  try {
    const response = await fetch(`${server.baseUrl}/api/extract/ai`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://x.example", page_text: "Env Lead env@lead.example" })
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.leads[0].name, "Env Lead");
  } finally {
    await server.stop();
    await mockLlm.close();
  }
});

test("AI extract returns sanitized recipe when want_recipe is set", async () => {
  const llmResponse = {
    model: "z-ai/glm-5.2",
    choices: [
      {
        message: {
          content: JSON.stringify({
            leads: [{ name: "Recipe Lead", emails: ["r@l.example"] }],
            recipe: {
              list_selector: ".team-card",
              fields: {
                name: { selector: "h3.name", attr: "text" },
                email: { selector: "a[href^='mailto:']", attr: "href" },
                bogus_field: { selector: ".x", attr: "text" },
                phone: { selector: "", attr: "href" }
              },
              record_kind: "person"
            }
          })
        }
      }
    ]
  };
  const mockLlm = await startMockServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(llmResponse));
  });
  const server = await startServer({ LLM_BASE_URL: mockLlm.url, LLM_API_KEY: "test-key" });
  try {
    const response = await fetch(`${server.baseUrl}/api/extract/ai`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: "https://recipes.example/list",
        page_text: "Recipe Lead r@l.example",
        dom_skeleton: "<div class='team-card'><h3 class='name'>Recipe Lead</h3></div>",
        want_recipe: true
      })
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.leads.length, 1);
    assert.equal(body.recipe.list_selector, ".team-card");
    assert.deepEqual(Object.keys(body.recipe.fields).sort(), ["email", "name"]);
    assert.equal(body.recipe.fields.name.attr, "text");
  } finally {
    await server.stop();
    await mockLlm.close();
  }
});

test("recipe store: save, fetch, and auto-disable after repeated failures", async () => {
  const server = await startServer();
  try {
    const recipe = {
      list_selector: ".card",
      fields: { name: { selector: "h3", attr: "text" }, email: { selector: "a[href^='mailto:']", attr: "href" } },
      record_kind: "person"
    };
    const save = await fetch(`${server.baseUrl}/api/extract/recipes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        domain: "WWW.Directory.Example",
        recipe,
        model: "z-ai/glm-5.2",
        url: "https://directory.example/list",
        sample_lead_count: 12
      })
    });
    assert.equal(save.status, 200);
    const saved = await save.json();
    assert.equal(saved.recipe.domain, "directory.example");
    assert.equal(saved.recipe.status, "active");

    const fetched = await fetch(`${server.baseUrl}/api/extract/recipes?domain=directory.example`).then((r) => r.json());
    assert.equal(fetched.recipe.recipe.list_selector, ".card");

    const okFeedback = await fetch(`${server.baseUrl}/api/extract/recipes/feedback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ domain: "directory.example", status: "success", lead_count: 12 })
    }).then((r) => r.json());
    assert.equal(okFeedback.recipe_status, "active");
    assert.equal(okFeedback.stats.leads, 12);

    let lastStatus = "";
    for (let i = 0; i < 3; i += 1) {
      const failure = await fetch(`${server.baseUrl}/api/extract/recipes/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ domain: "directory.example", status: "failure" })
      }).then((r) => r.json());
      lastStatus = failure.recipe_status;
    }
    assert.equal(lastStatus, "disabled");

    const afterDisable = await fetch(`${server.baseUrl}/api/extract/recipes?domain=directory.example`).then((r) =>
      r.json()
    );
    assert.equal(afterDisable.recipe.status, "disabled");

    const resave = await fetch(`${server.baseUrl}/api/extract/recipes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ domain: "directory.example", recipe, model: "z-ai/glm-5.2" })
    }).then((r) => r.json());
    assert.equal(resave.recipe.status, "active");
    assert.equal(resave.recipe.stats.consecutive_failures, 0);
  } finally {
    await server.stop();
  }
});

test("extension recipe runner extracts leads per list element from DOM", async () => {
  const source = await readFile("extension/extract-lead.js", "utf8");
  const match = source.match(/function runExtractionRecipe\(recipe\) \{[\s\S]*?\n\}/);
  assert.ok(match, "runExtractionRecipe not found in extract-lead.js");

  function makeElement(fields) {
    return {
      querySelectorAll(selector) {
        const value = fields[selector];
        if (!value) return [];
        return [
          {
            innerText: value.text || "",
            textContent: value.text || "",
            getAttribute(attr) {
              return value.attrs?.[attr] || "";
            }
          }
        ];
      }
    };
  }

  const cards = [
    makeElement({
      "h3.name": { text: "محمد الفارسي" },
      "a[href^='mailto:']": { attrs: { href: "mailto:m@firm.example?subject=hi" } },
      "a[href^='tel:']": { attrs: { href: "tel:+966 55 000 1111" } },
      ".city": { text: "الرياض" }
    }),
    makeElement({
      "h3.name": { text: "Sara Example" },
      "a[href^='mailto:']": { attrs: { href: "mailto:sara@x.example" } }
    }),
    makeElement({})
  ];

  const context = vm.createContext({
    document: {
      querySelectorAll(selector) {
        return selector === ".card" ? cards : [];
      }
    }
  });
  vm.runInContext(`${match[0]}; globalThis.__run = runExtractionRecipe;`, context);
  const leads = JSON.parse(JSON.stringify(context.__run({
    list_selector: ".card",
    record_kind: "person",
    fields: {
      name: { selector: "h3.name", attr: "text" },
      email: { selector: "a[href^='mailto:']", attr: "href" },
      phone: { selector: "a[href^='tel:']", attr: "href" },
      city: { selector: ".city", attr: "text" }
    }
  })));

  assert.equal(leads.length, 2);
  assert.equal(leads[0].name, "محمد الفارسي");
  assert.deepEqual(leads[0].emails, ["m@firm.example"]);
  assert.deepEqual(leads[0].phones, ["+966550001111"]);
  assert.equal(leads[0].city, "الرياض");
  assert.equal(leads[1].name, "Sara Example");
  assert.deepEqual(leads[1].phones, []);
});

test("AI debug reports are written for extraction runs and browsable via API", async () => {
  const llmResponse = {
    model: "z-ai/glm-5.2",
    choices: [
      {
        message: {
          content: JSON.stringify({
            leads: [{ name: "Debug Lead", emails: ["debug@x.example"] }],
            recipe: { list_selector: ".card", fields: { name: { selector: "h3", attr: "text" } } }
          })
        }
      }
    ],
    usage: { prompt_tokens: 10, completion_tokens: 20 }
  };
  const mockLlm = await startMockServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(llmResponse));
  });
  const server = await startServer({ LLM_BASE_URL: mockLlm.url, LLM_API_KEY: "test-key" });
  try {
    await fetch(`${server.baseUrl}/api/extract/ai`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: "https://debug.example/list",
        page_text: "Debug Lead debug@x.example",
        dom_skeleton: "<div class='card'><h3>Debug Lead</h3></div>",
        want_recipe: true
      })
    });

    const clientEvent = await fetch(`${server.baseUrl}/api/extract/debug/client`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "recipe-validation-failed",
        domain: "debug.example",
        url: "https://debug.example/list",
        message: "Recipe reproduced 1 of 5 AI leads.",
        detail: { recipe_lead_count: 1, llm_lead_count: 5 }
      })
    });
    assert.equal(clientEvent.status, 200);

    const list = await fetch(`${server.baseUrl}/api/extract/debug`).then((r) => r.json());
    assert.ok(list.reports.length >= 2);
    const kinds = list.reports.map((row) => row.kind);
    assert.ok(kinds.includes("ai-extract"));
    assert.ok(kinds.includes("recipe-validation-failed"));

    const extractSummary = list.reports.find((row) => row.kind === "ai-extract");
    assert.equal(extractSummary.lead_count, 1);
    assert.equal(extractSummary.recipe_returned, true);

    const full = await fetch(`${server.baseUrl}/api/extract/debug?file=${extractSummary.file}`).then((r) => r.json());
    assert.equal(full.report.url, "https://debug.example/list");
    assert.ok(full.report.llm.raw_content.includes("Debug Lead"));
    assert.ok(full.report.request.system_prompt.includes("RECIPE"));
    assert.equal(full.report.parsed.recipe.list_selector, ".card");
    assert.ok(!JSON.stringify(full.report).includes("test-key"), "debug report must not contain the API key");

    const badFile = await fetch(`${server.baseUrl}/api/extract/debug?file=../secrets.json`);
    assert.equal(badFile.status, 422);
  } finally {
    await server.stop();
    await mockLlm.close();
  }
});
