import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { buildAribDrcsFixture } from '../arib-fixture.js';
import { carouselTransportStream } from '../carousel-fixture.js';

const sample = resolve('.cache/streams/atsc-473.head.ts');
const scte35Sample = resolve('.cache/streams/scte35-sample.head.ts');
const dvbSample = resolve('.cache/streams/dvb-france-uhf33.head.ts');
const franceBitmapSample = resolve('.cache/streams/france-uhf30.head32.ts');
const japanAabSample = resolve('.cache/streams/japan-dttv-AAB.full.ts');
const aribDrcsSample = resolve('.cache/streams/arib-drcs.synthetic.ts');
const teletextSample = resolve('.cache/streams/nl-mid.ts');

test.describe('web console', () => {
  test.skip(!existsSync(sample), 'ATSC sample is not downloaded');

  test('loads a stream, navigates tabs and filters PIDs', async ({ page }) => {
    await page.goto('/');
    await page
      .getByPlaceholder('本地文件路径或 HTTP(S) TS 地址')
      .fill(sample);
    await page.getByRole('button', { name: '分析' }).click();

    await expect(page.getByText('ATSC', { exact: false }).first()).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText('KULX').first()).toBeVisible();
    await expect(page.getByText('MPEG-2 Video').first()).toBeVisible();

    await page.getByRole('button', { name: /^TelXito/ }).click();
    await expect(page.getByText('704x480').first()).toBeVisible();
    await page.getByRole('button', { name: '查看 PID', exact: true }).first().click();
    await expect(page.getByText('0x0041').first()).toBeVisible();

    await page.getByRole('button', { name: /^EPG/ }).click();
    await expect(page.locator('.epg-grid')).toBeVisible();
    await page.getByRole('button', { name: /^TelXito/ }).click();
    await expect(page.locator('.epg-events table')).toBeVisible();

    await page.locator('.epg-events tbody tr').first().click();
    const epgDetail = page.locator('.epg-detail-modal');
    await expect(epgDetail).toBeVisible();
    await expect(epgDetail.locator('.epg-detail-grid')).toContainText('事件');
    await expect(epgDetail.locator('.epg-detail-raw code').first()).toBeVisible();
    await epgDetail.getByRole('button', { name: '关闭', exact: true }).click();
    await expect(epgDetail).not.toBeVisible();

    await page.getByRole('button', { name: /^PID/ }).click();
    await page.locator('input.filter').fill('0x0034');
    await expect(page.getByText('0x0034').first()).toBeVisible();

    await page.locator('tbody tr').first().getByRole('button', { name: 'Hex', exact: true }).click();
    await expect(page.locator('.hex-dump')).toBeVisible();
    await expect(page.locator('.hex-byte.sync').first()).toBeVisible();
    await expect(page.locator('.hex-controls input').first()).not.toHaveValue('0');
  });

  test('shows tables as a PSI/SI tree with a detail pane', async ({ page }) => {
    await page.goto('/');
    await page
      .getByPlaceholder('本地文件路径或 HTTP(S) TS 地址')
      .fill(sample);
    await page.getByRole('button', { name: '分析' }).click();
    await expect(page.getByText('KULX').first()).toBeVisible({ timeout: 30_000 });

    await page.getByRole('button', { name: /^表/ }).click();
    await expect(page.locator('.psi-tree-row').first()).toBeVisible();
    await expect(page.locator('.psi-tree-detail-pane')).toContainText('PAT');
    const levelOneCount = await page.locator('.psi-tree-row').count();
    expect(levelOneCount).toBeGreaterThan(1);
    await page.getByRole('button', { name: '展开全部' }).click();
    await expect
      .poll(() => page.locator('.psi-tree-row').count())
      .toBeGreaterThan(levelOneCount);
    await page.getByRole('button', { name: '收起全部' }).click();
    await expect(page.locator('.psi-tree-row')).toHaveCount(levelOneCount);
    await page.getByRole('button', { name: '列表视图' }).click();
    await expect(page.locator('table thead')).toContainText('PID');
  });

  test('renders SCTE-35 events and breaks on the timeline tab', async ({ page }) => {
    test.skip(!existsSync(scte35Sample), 'SCTE-35 sample is not downloaded');
    await page.goto('/');
    await page
      .getByPlaceholder('本地文件路径或 HTTP(S) TS 地址')
      .fill(scte35Sample);
    await page.getByRole('button', { name: '分析' }).click();
    await expect(page.getByText('SCTE-35', { exact: false }).first()).toBeVisible({
      timeout: 60_000,
    });

    await page.getByRole('button', { name: /^时间线/ }).click();
    await expect(page.getByText('SCTE-35 标记')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText('splice_insert').first()).toBeVisible();
    await expect(page.locator('.timeline-marker-track').first()).toBeVisible();
  });

  test('restores the session and tab from the URL hash', async ({ page }) => {
    await page.goto('/');
    await page
      .getByPlaceholder('本地文件路径或 HTTP(S) TS 地址')
      .fill(sample);
    await page.getByRole('button', { name: '分析' }).click();
    await expect(page.getByText('KULX').first()).toBeVisible({ timeout: 30_000 });
    const url = page.url();
    expect(url).toContain('#session=');
    await page.reload();
    await expect(page.getByText('KULX').first()).toBeVisible({ timeout: 30_000 });
  });

  test('shows validation diagnostics and switches between Chinese and English', async ({ page }) => {
    await page.goto('/');
    await page
      .getByPlaceholder('本地文件路径或 HTTP(S) TS 地址')
      .fill(sample);
    await page.getByRole('button', { name: '分析' }).click();
    await expect(page.getByText('KULX').first()).toBeVisible({ timeout: 30_000 });

    await page.getByRole('button', { name: /^校验/ }).click();
    await expect(page.locator('.validation-status')).toBeVisible();
    await expect(page.locator('.validation-state')).toHaveText(/PASS|WARN|FAIL/);
    await expect(page.locator('.severity-filter')).toBeVisible();

    await page.getByRole('button', { name: 'EN', exact: true }).click();
    await expect(
      page.getByPlaceholder('Local file path or HTTP(S) TS URL'),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: /^Validation/ })).toBeVisible();
    await expect(page.locator('.validation-state')).toHaveText(/PASS|WARN|FAIL/);
  });

  test('sorts, hides columns and expands descriptors', async ({ page }) => {
    await page.goto('/');
    await page
      .getByPlaceholder('本地文件路径或 HTTP(S) TS 地址')
      .fill(sample);
    await page.getByRole('button', { name: '分析' }).click();
    await expect(page.getByText('KULX').first()).toBeVisible({ timeout: 30_000 });

    await page.locator('.descriptor-trigger').first().click();
    await expect(page.locator('.descriptor-modal')).toBeVisible();
    await expect(page.locator('.descriptor-modal .descriptor-list')).toBeVisible();
    await page
      .locator('.descriptor-modal')
      .getByRole('button', { name: '关闭', exact: true })
      .click();
    await expect(page.locator('.descriptor-modal')).not.toBeVisible();

    await page.locator('.tabs').getByRole('button', { name: /^PID/ }).click();
    const packetsHeader = page.getByRole('button', { name: /包数/ });
    await packetsHeader.click();
    await packetsHeader.click();
    await expect(page.locator('th[aria-sort="descending"]')).toBeVisible();
    await expect(page.locator('table tbody tr').first()).toContainText('0x0031');

    await page.locator('.column-menu summary').click();
    await page.getByLabel('负载').uncheck();
    await expect(page.locator('table thead')).not.toContainText('负载');
  });

  test('renders descriptor fields as readable strings', async ({ page }) => {
    test.skip(!existsSync(dvbSample), 'DVB sample is not downloaded');
    await page.goto('/');
    await page
      .getByPlaceholder('本地文件路径或 HTTP(S) TS 地址')
      .fill(dvbSample);
    await page.getByRole('button', { name: '分析' }).click();
    await expect(page.getByText('France 2 POC DAS').first()).toBeVisible({
      timeout: 30_000,
    });

    const row = page.locator('table tbody tr').filter({ hasText: '0x0082' }).first();
    await row.locator('.descriptor-trigger').first().click();
    const modal = page.locator('.descriptor-modal');
    await expect(modal).toBeVisible();
    await expect(
      modal.locator('dd').filter({ hasText: 'French (fra)' }),
    ).toBeVisible();
    await expect(modal.getByText('Stream identifier')).toBeVisible();
    await modal.getByRole('button', { name: '关闭', exact: true }).click();

    const adRow = page.locator('table tbody tr').filter({ hasText: '0x0083' }).first();
    await expect(adRow.locator('.trait-badge.audio-description')).toBeVisible();
    await expect(adRow.locator('.trait-badge.language')).toHaveText('French (fra)');
    await adRow.locator('.descriptor-trigger').first().click();
    const adModal = page.locator('.descriptor-modal');
    await expect(adModal).toBeVisible();
    await expect(adModal.getByText(/audio description/i).first()).toBeVisible();
    await adModal.getByRole('button', { name: '关闭', exact: true }).click();

    await page.getByLabel('仅辅助轨道').check();
    await expect(page.locator('table tbody tr')).toHaveCount(1);
    await expect(page.locator('table tbody tr').first()).toContainText('0x0083');
  });

  test('shows ATSC caption service details', async ({ page }) => {
    await page.goto('/');
    await page
      .getByPlaceholder('本地文件路径或 HTTP(S) TS 地址')
      .fill(sample);
    await page.getByRole('button', { name: '分析' }).click();
    await expect(page.getByText('KULX').first()).toBeVisible({ timeout: 30_000 });

    await page.getByRole('button', { name: /^Quest/ }).click();
    const row = page.locator('table tbody tr').filter({ hasText: '0x0061' }).first();
    await row.locator('.descriptor-trigger').first().click();
    const modal = page.locator('.descriptor-modal');
    await expect(modal.getByText(/708 service=1 4:3/).first()).toBeVisible();
    await modal.getByRole('button', { name: '关闭', exact: true }).click();

    await page.locator('.tabs').getByRole('button', { name: /^字幕/ }).click();
    await expect(page.locator('.subtitle-filter')).toContainText('CC');
    await expect(page.locator('.subtitle-group-head')).toContainText('CC 隐藏字幕', {
      timeout: 30_000,
    });
    await expect(page.locator('.subtitle-kind.caption').first()).toBeVisible();

    const cards = page.locator('.subtitle-stream');
    await expect(cards.filter({ hasText: 'CEA-608' })).toHaveCount(1);
    await expect(cards.filter({ hasText: 'CEA-708' })).toHaveCount(1);
    for (const mode of ['CEA-608', 'CEA-708']) {
      const card = cards.filter({ hasText: mode }).first();
      const canvas = card.locator('.subtitle-preview canvas').first();
      await expect(canvas).toBeVisible();
      await expect
        .poll(
          async () =>
            canvas.evaluate((element) => {
              const target = element as HTMLCanvasElement;
              const context = target.getContext('2d');
              if (!context) return 0;
              const data = context.getImageData(0, 0, target.width, target.height).data;
              let nonTransparent = 0;
              for (let i = 3; i < data.length; i += 4) {
                if (data[i] !== 0) nonTransparent += 1;
              }
              return nonTransparent;
            }),
          { timeout: 30_000 },
        )
        .toBeGreaterThan(100);
    }
  });

  test('renders DVB bitmap subtitle pixels', async ({ page }) => {
    test.skip(!existsSync(franceBitmapSample), 'France bitmap sample is not downloaded');
    await page.goto('/');
    await page
      .getByPlaceholder('本地文件路径或 HTTP(S) TS 地址')
      .fill(franceBitmapSample);
    await page.getByRole('button', { name: '分析' }).click();
    await expect(page.getByText('M6').first()).toBeVisible({ timeout: 30_000 });

    await page.locator('.tabs').getByRole('button', { name: /^字幕/ }).click();
    await expect(page.locator('.subtitle-group-head')).toContainText('字幕', {
      timeout: 30_000,
    });
    await page.getByRole('button', { name: /M6/ }).click();
    await expect(page.locator('.subtitle-preview canvas').first()).toBeVisible();
    await expect
      .poll(
        async () =>
          page.locator('.subtitle-preview canvas').first().evaluate((element) => {
            const canvas = element as HTMLCanvasElement;
            const context = canvas.getContext('2d');
            if (!context) return 0;
            const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
            let nonTransparent = 0;
            for (let i = 3; i < data.length; i += 4) {
              if (data[i] !== 0) nonTransparent += 1;
            }
            return nonTransparent;
          }),
        { timeout: 30_000 },
      )
      .toBeGreaterThan(1000);
  });

  test('renders ARIB styled text-layer preview', async ({ page }) => {
    test.skip(!existsSync(japanAabSample), 'Japan AAB sample is not downloaded');
    await page.goto('/');
    await page
      .getByPlaceholder('本地文件路径或 HTTP(S) TS 地址')
      .fill(japanAabSample);
    await page.getByRole('button', { name: '分析' }).click();
    await expect(page.getByText('秋田朝日放送').first()).toBeVisible({ timeout: 30_000 });

    await page.locator('.tabs').getByRole('button', { name: /^字幕/ }).click();
    await expect(page.locator('.subtitle-group-head')).toContainText('字幕', {
      timeout: 30_000,
    });
    await page.getByRole('button', { name: /#18848/ }).click();
    await expect(page.locator('.subtitle-preview canvas').first()).toBeVisible();
    await expect(page.locator('.subtitle-preview-note')).toContainText('ARIB 样式层');
    await expect
      .poll(
        async () =>
          page.locator('.subtitle-preview canvas').first().evaluate((element) => {
            const canvas = element as HTMLCanvasElement;
            const context = canvas.getContext('2d');
            if (!context) return 0;
            const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
            let cyan = 0;
            for (let i = 0; i < data.length; i += 4) {
              if ((data[i + 3] ?? 0) === 0) continue;
              if (data[i] === 0 && data[i + 1] === 255 && data[i + 2] === 255) {
                cyan += 1;
              }
            }
            return cyan;
          }),
        { timeout: 30_000 },
      )
      .toBeGreaterThan(100);
  });

  test('renders ARIB DRCS glyphs and font metrics', async ({ page }) => {
    writeFileSync(aribDrcsSample, buildAribDrcsFixture());
    const created = await page.request.post('/api/sessions', {
      data: { source: aribDrcsSample, bytes: 0 },
    });
    expect(created.ok()).toBe(true);
    const session = (await created.json()) as { id: string };
    const response = await page.request.get(`/api/sessions/${session.id}/subtitles`);
    expect(response.ok()).toBe(true);
    const report = (await response.json()) as {
      services: Array<{
        streams: Array<{
          preview?: {
            drcs?: boolean;
            metrics?: { profile: string; fontHeight: number };
            frames: Array<{ drcs?: Array<{ width: number; height: number }> }>;
          };
        }>;
      }>;
    };
    const preview = report.services[0]?.streams[0]?.preview;
    expect(preview?.drcs).toBe(true);
    expect(preview?.metrics?.profile).toBe('A');
    expect(preview?.metrics?.fontHeight).toBe(36);
    expect(preview?.frames[0]?.drcs?.[0]).toMatchObject({ width: 16, height: 18 });

    await page.goto(`/#session=${session.id}&tab=subtitles`);
    await page.locator('.subtitle-filter').waitFor({ timeout: 30_000 });
    await page.getByRole('button', { name: /#1/ }).click();
    await expect(page.locator('.subtitle-preview canvas').first()).toBeVisible();
    await expect
      .poll(
        async () =>
          page.locator('.subtitle-preview canvas').first().evaluate((element) => {
            const canvas = element as HTMLCanvasElement;
            const context = canvas.getContext('2d');
            if (!context) return 0;
            const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
            let nonTransparent = 0;
            for (let i = 3; i < data.length; i += 4) {
              if (data[i] !== 0) nonTransparent += 1;
            }
            return nonTransparent;
          }),
        { timeout: 30_000 },
      )
      .toBeGreaterThan(1000);
  });

  test('shows per-programme Teletext subtitles', async ({ page }) => {
    test.skip(!existsSync(teletextSample), 'Teletext sample is not downloaded');
    await page.goto('/');
    await page
      .getByPlaceholder('本地文件路径或 HTTP(S) TS 地址')
      .fill(teletextSample);
    await page.getByRole('button', { name: '分析' }).click();
    await expect(page.getByText('NPO 1').first()).toBeVisible({ timeout: 30_000 });

    await page.locator('.tabs').getByRole('button', { name: /^字幕/ }).click();
    await expect(page.locator('.subtitle-filter')).toContainText('TTX');
    await expect(page.locator('.subtitle-group-head')).toContainText('Teletext 图文电视', {
      timeout: 30_000,
    });
    await expect(page.locator('.subtitle-kind.teletext').first()).toBeVisible();
    await expect(page.locator('.subtitle-preview canvas').first()).toBeVisible();
    await expect(page.getByText('Teletext 字幕').first()).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText('Ja, in 2012').first()).toBeVisible();

    await page.getByRole('button', { name: /^NPO 2/ }).click();
    await expect(page.getByText('8:88').first()).toBeVisible();
  });
});

test.describe('object carousel', () => {
  const carouselSample = resolve('.cache/streams/carousel-synthetic.ts');

  test('lists the rebuilt directory tree and downloads a file', async ({ page }) => {
    writeFileSync(carouselSample, carouselTransportStream({ blockSize: 64 }));
    const created = await page.request.post('/api/sessions', {
      data: { source: carouselSample, bytes: 0 },
    });
    expect(created.ok()).toBe(true);
    const session = (await created.json()) as { id: string };

    const response = await page.request.get(`/api/sessions/${session.id}/carousel`);
    expect(response.ok()).toBe(true);
    const scan = (await response.json()) as {
      carousels: Array<{ root?: string; entries: Array<{ path: string }> }>;
      files: Array<{ path: string; available: boolean }>;
    };
    expect(scan.carousels[0]?.root).toBe('/');
    expect(scan.carousels[0]?.entries.map((entry) => entry.path)).toEqual([
      '/',
      '/index.html',
      '/css',
      '/css/site.css',
    ]);
    expect(scan.files.map((file) => file.path).sort()).toEqual(['/css/site.css', '/index.html']);

    const download = await page.request.get(
      `/api/sessions/${session.id}/carousel/file?path=%2Findex.html&pid=0x0300`,
    );
    expect(download.ok()).toBe(true);
    expect(await download.text()).toContain('hello carousel');

    await page.goto(`/#session=${session.id}&tab=data`);
    await expect(page.locator('.carousel-tree')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('index.html').first()).toBeVisible();
    await expect(page.getByText('site.css').first()).toBeVisible();
    await expect(page.getByText('下载').first()).toBeVisible();
  });
});
