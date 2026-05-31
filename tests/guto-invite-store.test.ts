import "./test-env.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createInvite,
  regenerateInviteByUserId,
  findInviteByUserId,
  revokeInviteByUserId,
  getAllInvites,
} from "../src/invite-store.js";

// Regressão (achado no QA 31/05, confirmado no Redis de prod):
// GET /admin/students/:id/invite devolvia 404 mesmo com um convite válido,
// porque findInviteByUserId pegava o PRIMEIRO registro do usuário — que podia
// ser um `revoked` antigo. E o regenerate só revogava o primeiro, acumulando
// vários pending_claim válidos ao mesmo tempo.
describe("Invite store — convite vigente ignora revogados (bug do 404)", () => {
  it("findInviteByUserId retorna o pending mesmo havendo um revoked antigo", async () => {
    const u = "qa-invite-find-1";
    await createInvite({ userId: u, name: "QA", coachId: "admin" });
    await revokeInviteByUserId(u); // revoga o anterior
    const fresh = await createInvite({ userId: u, name: "QA", coachId: "admin" }); // novo pending

    const found = await findInviteByUserId(u);
    assert.ok(found, "deve achar um convite");
    assert.equal(found?.status, "pending_claim", "retorna o pending, não o revoked");
    assert.equal(found?.tokenHash, fresh.invite.tokenHash, "retorna o mais recente");
  });

  it("regenerate revoga TODOS os antigos e deixa só 1 pending", async () => {
    const u = "qa-invite-regen-1";
    await createInvite({ userId: u, name: "QA", coachId: "admin" });
    await createInvite({ userId: u, name: "QA", coachId: "admin" }); // estado sujo: 2 pendings
    await regenerateInviteByUserId({ userId: u, name: "QA", coachId: "admin" });

    const mine = (await getAllInvites()).filter((i) => i.userId === u);
    const pendings = mine.filter((i) => i.status === "pending_claim");
    assert.equal(pendings.length, 1, "só 1 pending após regenerate (resto revogado)");
    assert.equal((await findInviteByUserId(u))?.status, "pending_claim");
  });

  it("usuário sem convite → null (não inventa)", async () => {
    assert.equal(await findInviteByUserId("qa-invite-none-xyz"), null);
  });
});
