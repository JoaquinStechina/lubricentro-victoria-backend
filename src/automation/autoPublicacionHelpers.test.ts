import { test } from "node:test";
import assert from "node:assert/strict";
import { debePublicarAutomaticamente } from "./autoPublicacionHelpers.js";

test("debePublicarAutomaticamente: confirmacion_pendiente sin advertencias -> true", () => {
  assert.equal(debePublicarAutomaticamente("confirmacion_pendiente", 0), true);
});

test("debePublicarAutomaticamente: confirmacion_pendiente con advertencias -> false", () => {
  assert.equal(debePublicarAutomaticamente("confirmacion_pendiente", 2), false);
});

test("debePublicarAutomaticamente: revision_pendiente nunca se auto-publica, incluso sin advertencias", () => {
  assert.equal(debePublicarAutomaticamente("revision_pendiente", 0), false);
});

test("debePublicarAutomaticamente: cualquier otro estado -> false", () => {
  assert.equal(debePublicarAutomaticamente("error", 0), false);
  assert.equal(debePublicarAutomaticamente("completado", 0), false);
  assert.equal(debePublicarAutomaticamente("pendiente", 0), false);
  assert.equal(debePublicarAutomaticamente("procesando", 0), false);
});
