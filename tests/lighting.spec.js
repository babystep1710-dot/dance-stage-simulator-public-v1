import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/");

  // 各テストを独立した新規Project状態で行う。
  await page.evaluate(() => {
    localStorage.clear();
  });

  await page.reload();
  await page.waitForLoadState("networkidle");
});

const lightingDisplayToggle = (page) =>
  page.getByLabel("照明を表示", { exact: true });

async function enableLighting(page) {
  const toggle = lightingDisplayToggle(page);
  await expect(toggle).toBeVisible();
  await toggle.check();
  await expect(toggle).toBeChecked();
}

async function addCurrentLightingScene(page) {
  const addButton = page.getByRole("button", {
    name: "＋ この構成に照明設定を追加",
  });

  await expect(addButton).toBeVisible();
  await addButton.click();

  await expect(
    page.getByLabel("この構成で照明を使用")
  ).toBeVisible();
}

test("新規ProjectはScene未作成で、照明表示とScene追加入口を利用できる", async ({ page }) => {
  await expect(page.getByLabel("照明機能を使う", { exact: true })).toHaveCount(0);
  await expect(lightingDisplayToggle(page)).toBeChecked();
  await expect(page.getByLabel("この構成で照明を使用")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "＋ この構成に照明設定を追加" })).toBeVisible();
});

test("照明表示をOFF/ONにしてもScene追加入口を利用できる", async ({ page }) => {
  await lightingDisplayToggle(page).uncheck();
  await expect(lightingDisplayToggle(page)).not.toBeChecked();
  await expect(page.getByRole("button", { name: "＋ この構成に照明設定を追加" })).toBeVisible();
  await enableLighting(page);
  await expect(lightingDisplayToggle(page)).toBeChecked();
  await expect(page.getByRole("button", { name: "＋ この構成に照明設定を追加" })).toBeVisible();
});

test("Lighting Sceneを追加してON/OFFできる", async ({ page }) => {
  await enableLighting(page);
  await addCurrentLightingScene(page);

  const sceneToggle = page.getByLabel("この構成で照明を使用");

  await expect(sceneToggle).toBeChecked();

  await sceneToggle.uncheck();
  await expect(sceneToggle).not.toBeChecked();

  await sceneToggle.check();
  await expect(sceneToggle).toBeChecked();
});

test("Lighting Sceneを削除できる", async ({ page }) => {
  await enableLighting(page);
  await addCurrentLightingScene(page);

  await page.getByRole("button", {
    name: "この構成の照明設定を削除",
  }).click();

  await expect(
    page.getByRole("button", {
      name: "＋ この構成に照明設定を追加",
    })
  ).toBeVisible();

  await expect(
    page.getByRole("button", {
      name: "この構成の照明設定を削除",
    })
  ).toHaveCount(0);
});

test("同一Projectで構成を複製するとLighting Sceneも引き継がれる", async ({
  page,
}) => {
  await enableLighting(page);
  await addCurrentLightingScene(page);

  // Phase T4: SceneメモUIは正式廃止。noteの保存互換性とは分けて、
  // 現行UIのenabled引継ぎと、複製後の独立した編集を確認する。
  const sceneToggle = page.getByLabel("この構成で照明を使用", { exact: true });
  await sceneToggle.uncheck();
  await expect(sceneToggle).not.toBeChecked();

  // 構成カードへフォーカスして、既存の構成コピー／貼り付けを使う。
  await page.getByRole("button", { name: /^1番目の構成/ }).click();
  await page.keyboard.press("Meta+c");
  await page.keyboard.press("Meta+v");
  await expect(page.getByRole("button", { name: /^2番目の構成/ })).toBeVisible();
  await page.getByRole("button", { name: /^2番目の構成/ }).click();
  await expect(sceneToggle).toBeVisible();
  await expect(sceneToggle).not.toBeChecked();

  // 複製先だけをONにしても、元SceneのOFFは維持される。
  await sceneToggle.check();
  await expect(sceneToggle).toBeChecked();
  await page.getByRole("button", { name: /^1番目の構成/ }).click();
  await expect(sceneToggle).toBeVisible();
  await expect(sceneToggle).not.toBeChecked();
  await page.getByRole("button", { name: /^2番目の構成/ }).click();
  await expect(sceneToggle).toBeChecked();
});

test("Formation削除後もLighting UIが正常に扱える", async ({ page }) => {
  await enableLighting(page);
  await addCurrentLightingScene(page);

  // まず構成をもう1つ作り、削除可能な状態にする。
  await page.getByRole("button", {
    name: "新しい構成を追加",
  }).click();

  await expect(
    page.locator('[data-slide-index="1"]')
  ).toBeVisible();

  // 新しい構成は元構成のSceneを引き継ぐため、追加入口ではなくSceneのUIを確認する。
  await expect(
    page.getByLabel("この構成で照明を使用", { exact: true })
  ).toBeChecked();

  // Undoで新しい構成を消す。
  // これによってslides変更後もLighting Scene参照が壊れないことを確認する。
  const undoButton = page.getByTitle(/元に戻す/);
  await undoButton.click();

  await expect(
    page.locator('[data-slide-index="1"]')
  ).toHaveCount(0);

  // 元構成のSceneへ正常に戻れる。
  await expect(
    page.getByLabel("この構成で照明を使用")
  ).toBeVisible();
});

test("照明表示OFFでも従来のFormation編集を使える", async ({ page }) => {
  await lightingDisplayToggle(page).uncheck();
  await expect(lightingDisplayToggle(page)).not.toBeChecked();

  await page.getByRole("button", {
    name: "＋ 出演者を追加",
  }).click();

  await expect(
    page.getByText(/出演者一覧（1 \/ 100人）/)
  ).toBeVisible();

  await page.getByRole("button", {
    name: "新しい構成を追加",
  }).click();

  await expect(
    page.locator('[data-slide-index="1"]')
  ).toBeVisible();

  // Lightingは依然OFF。
  await expect(lightingDisplayToggle(page)).not.toBeChecked();
});

test("舞台の外観設定が表示される", async ({ page }) => {
  await expect(
    page.getByText("舞台の外観", { exact: true })
  ).toBeVisible();

  await expect(
    page.getByText("床の色", { exact: true })
  ).toBeVisible();

  await expect(
    page.getByText("壁・背景の色", { exact: true })
  ).toBeVisible();
});
