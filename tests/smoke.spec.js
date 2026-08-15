import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/");

  await page.evaluate(() => {
    localStorage.clear();
  });

  await page.reload();
  await page.waitForLoadState("networkidle");
});

test("アプリが正常に起動する", async ({ page }) => {
  await expect(
    page.getByRole("button", { name: "平面図（真上）" })
  ).toBeVisible();

  await expect(
    page.getByRole("button", { name: "俯瞰客席ビュー" })
  ).toBeVisible();

  await expect(
    page.getByText(/出演者一覧（0 \/ 100人）/)
  ).toBeVisible();
});

test("平面図と俯瞰客席ビューを切り替えられる", async ({ page }) => {
  const topButton = page.getByRole("button", {
    name: "平面図（真上）",
  });

  const audienceButton = page.getByRole("button", {
    name: "俯瞰客席ビュー",
  });

  await expect(topButton).toBeVisible();
  await expect(audienceButton).toBeVisible();

  await audienceButton.click();

  await expect(
    page.getByText("下手").first()
  ).toBeVisible();

  await topButton.click();

  await expect(
    page.getByText("下手").first()
  ).toBeVisible();
});

test("出演者を追加できる", async ({ page }) => {
  await expect(
    page.getByText(/出演者一覧（0 \/ 100人）/)
  ).toBeVisible();

  await page.getByRole("button", {
    name: "＋ 出演者を追加",
  }).click();

  await expect(
    page.getByText(/出演者一覧（1 \/ 100人）/)
  ).toBeVisible();

  await expect(
    page.getByRole("button", { name: /1番/ }).first()
  ).toBeVisible();
});

test("構成追加とUndoができる", async ({ page }) => {
  const addSlide = page.getByRole("button", {
    name: "新しい構成を追加",
  });

  await expect(addSlide).toBeVisible();

  await addSlide.click();

  await expect(
    page.locator('[data-slide-index="1"]')
  ).toBeVisible();

  const undoButton = page.getByTitle(/元に戻す/);
  await expect(undoButton).toBeEnabled();

  await undoButton.click();

  await expect(
    page.locator('[data-slide-index="1"]')
  ).toHaveCount(0);
});

test("出力画面を開ける", async ({ page }) => {
  await page.getByRole("button", {
    name: "出力",
  }).click();

  await expect(
    page.getByRole("heading", { name: "出力" })
  ).toBeVisible();

  await expect(
    page.getByText("出力する構成")
  ).toBeVisible();

  await expect(
    page.getByText("表示オプション")
  ).toBeVisible();
});
