// Shared by the browser checks: start a design through the New design dialog the way a person does (Setup new job, then Create job).
//   await startDesign(page);                                  CNC, 600 x 400 x 18, datum bottom-left, Z zero on the surface (the dialog's own start)
//   await startDesign(page, { laser: '3018 + laser head' });  a laser job of that size, saved under that name
//   await startDesign(page, { type: 'canvas', width: 300, height: 180 });
//   sides: 2, zZero: 'bed', datum: 'c' set the CNC extras
//   save: 'name' also saves the setup under that name (a laser is always saved, under its own name)
//   add open: true when the dialog is not open yet (a second design: the New button of the tool bar is pressed first)
const LASERS = { '3018 + laser head': [300, 180], 'Small diode laser': [400, 400], 'CO2 laser 600 x 400': [600, 400], 'CO2 laser 1000 x 600 (Ruida)': [1000, 600] };

export async function startDesign(page, o = {}) {
  if (o.open) await page.getByRole('navigation', { name: 'Tools' }).getByRole('button', { name: /^New design/ }).click();
  if (o.open) { const ask = page.getByRole('dialog', { name: 'Unsaved changes' }); if (await ask.waitFor({ timeout: 800 }).then(() => true, () => false)) await ask.getByRole('button', { name: "Don't save" }).click(); }
  const dlg = page.getByRole('dialog', { name: 'New design' });
  await dlg.waitFor();
  await dlg.getByRole('button', { name: 'Setup new job' }).click();
  const job = page.getByRole('dialog', { name: 'Setup new job' });
  await job.waitFor();
  const type = o.laser ? 'laser' : o.type ?? 'cnc';
  const [w, h] = o.laser ? (LASERS[o.laser] ?? [o.width ?? 300, o.height ?? 180]) : [o.width, o.height];
  await job.getByRole('radio', { name: { cnc: 'CNC', laser: 'Laser', canvas: 'Canvas only' }[type], exact: true }).check();
  const fill = async (label, v) => { const f = job.getByLabel(label, { exact: true }); await f.fill(String(v)); await f.press('Enter'); };
  if (w !== undefined) await fill('Work area width', w);
  if (h !== undefined) await fill('Work area height', h);
  if (o.thickness !== undefined && type !== 'canvas') await fill('Material thickness', o.thickness);
  if (type === 'cnc' && o.thickness === undefined && (w !== undefined || h !== undefined)) { /* the dialog's own thickness (18) stays */ }
  if (type === 'cnc') {
    if (o.sides === 2) await job.getByRole('radio', { name: 'Double sided' }).check();
    if (o.zZero === 'bed') await job.getByRole('radio', { name: 'Machine bed' }).check();
    if (o.datum) await job.getByRole('radio', { name: `datum ${o.datum}` }).click();
  }
  const saveAs = o.save ?? o.laser;
  if (saveAs) { await job.getByRole('checkbox', { name: 'Save this setup' }).check(); await job.getByLabel('Setup name', { exact: true }).fill(saveAs); }
  await job.getByRole('button', { name: 'Create job' }).click();
  await job.waitFor({ state: 'detached' });
}
