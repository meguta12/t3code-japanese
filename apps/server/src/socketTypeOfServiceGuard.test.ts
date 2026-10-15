import { assert, it } from "vite-plus/test";

import { installSocketTypeOfServiceGuard } from "./socketTypeOfServiceGuard.ts";

const errnoError = (code: string) => Object.assign(new Error(code), { code });

const makePrototype = (error: Error) => {
  let calls = 0;
  const prototype = {
    setTypeOfService() {
      calls += 1;
      throw error;
    },
  } as unknown as NonNullable<Parameters<typeof installSocketTypeOfServiceGuard>[0]> & {
    setTypeOfService(tos: number): unknown;
  };
  return { prototype, calls: () => calls };
};

it("ignores EINVAL from setTypeOfService instead of crashing the process", () => {
  const { prototype } = makePrototype(errnoError("EINVAL"));
  installSocketTypeOfServiceGuard(prototype);

  assert.strictEqual(prototype.setTypeOfService(0x10), prototype);
});

it("still throws other setTypeOfService errors", () => {
  const { prototype } = makePrototype(errnoError("EBADF"));
  installSocketTypeOfServiceGuard(prototype);

  assert.throws(() => prototype.setTypeOfService(0x10), "EBADF");
});

it("wraps the prototype only once", () => {
  const { prototype, calls } = makePrototype(errnoError("EINVAL"));
  installSocketTypeOfServiceGuard(prototype);
  installSocketTypeOfServiceGuard(prototype);

  prototype.setTypeOfService(0x10);
  assert.equal(calls(), 1);
});
