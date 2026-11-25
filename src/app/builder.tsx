import { router, Stack, useLocalSearchParams } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import { useSQLiteContext } from 'expo-sqlite';
import { useEffect, useMemo, useState } from 'react';
import { Image, Platform, Pressable, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { bandOf, type Band, type NormRect } from '@inkstat/ocr-engine';
import { namesIn, newFormTemplate, parseRule, type FieldDef, type FormTemplate, type RowTable, type ValueKind } from '@inkstat/forms';

import { getTemplate, saveTemplate } from '@/db';
import { keepImage, newId } from '@/lib/files';
import { alignedTo, allTemplates, hasSample, samplePhoto } from '@/lib/reader';
import { Button, Card, T } from '@/ui/components';
import { useDialog } from '@/ui/Dialog';
import { EditSheet, type SheetField } from '@/ui/EditSheet';
import { PageMarker, type MarkerShape } from '@/ui/PageMarker';
import { COLUMN_COLOR as COLUMN, FIELD_COLOR as FIELD, TABLE_COLOR as TABLE, shapesOf } from '@/ui/templateShapes';
import { base, fonts, space, useColors } from '@/ui/theme';

import { recognizePageText } from '../../modules/page-text';

const KINDS: { kind: ValueKind; label: string; hint: string }[] = [
  { kind: 'text', label: 'Text', hint: 'Names, IDs, notes: kept as written' },
  { kind: 'number', label: 'Number', hint: 'Readings and amounts: 12.5, 1,200' },
  { kind: 'integer', label: 'Whole number', hint: 'Counts and codes: 3, 28' },
  { kind: 'date', label: 'Date', hint: '10/14/26 becomes 2026-10-14' },
  { kind: 'time', label: 'Time', hint: '9:40, 3:15pm' },
  { kind: 'checkbox', label: 'Tick box', hint: 'Ticked or not' },
  { kind: 'timeTemp', label: 'Time and temperature', hint: 'One cell like 3:20/68' },
];

/** A value's key in the data: from its label, letters and digits, unique in the template. */
function idFor(label: string, taken: Set<string>): string {
  const words = label.toLowerCase().match(/[a-z0-9]+/g) ?? ['value'];
  let id = words.map((w, i) => (i ? w[0].toUpperCase() + w.slice(1) : w)).join('');
  if (/^\d/.test(id)) id = `v${id}`;
  let out = id;
  for (let n = 2; taken.has(out); n++) out = `${id}${n}`;
  return out;
}

type Editing = { kind: 'field'; id: string } | { kind: 'rows'; table: string } | { kind: 'column'; table: string; column: string } | null;
type Asking = { kind: 'value' } | { kind: 'table' } | { kind: 'column'; table: string } | { kind: 'name' } | { kind: 'check' } | null;

/**
 * Build a template on a photo of the form: draw a box around a value or a table's
 * rows and say what it is (or name a value first, then place its box); a table
 * also gets a column for each value. A built-in can be copied here (`copy`) and
 * changed on its sample photo. Checks are
 * rules on the values (e.g. "total == a + b"). The photo's printed words are kept
 * so InkStat recognises the form and lines it up next time.
 */
export default function Builder() {
  const db = useSQLiteContext();
  const c = useColors();
  const insets = useSafeAreaInsets();
  const dialog = useDialog();
  const params = useLocalSearchParams<{ id?: string; uri?: string; name?: string; source?: string; copy?: string }>();
  const { width: screenW, height: screenH } = useWindowDimensions();

  const [tpl, setTpl] = useState<FormTemplate | null>(null);
  const [aspect, setAspect] = useState(0.77);
  const [editing, setEditing] = useState<Editing>(null);
  const [asking, setAsking] = useState<Asking>(null);
  const [saving, setSaving] = useState(false);
  /** A box drawn on the page, waiting to be named. */
  const [drawn, setDrawn] = useState<NormRect | null>(null);
  /** A built-in being copied when it has no sample photo: the user photographs the form first. */
  const [seed, setSeed] = useState<FormTemplate | null>(null);

  const start = (photoUri: string | null, from?: FormTemplate) => {
    const now = Date.now();
    setTpl(
      from ?? {
        kind: 'form',
        version: 1,
        id: `tpl-${newId()}`,
        name: params.name ?? 'My form',
        source: params.source || undefined,
        fields: [],
        tables: [],
        checks: [],
        photoUri,
        createdAt: now,
        updatedAt: now,
      },
    );
  };

  useEffect(() => {
    // Loaded after the first render either way (a saved template comes from the database).
    void (params.id ? getTemplate(db, params.id) : Promise.resolve(null)).then(async (t) => {
      if (t) return start(t.photoUri, t);
      if (params.copy) {
        const found = (await allTemplates(db)).find((x) => x.id === params.copy);
        if (!found) return;
        const sampleId = found.builtinId ?? found.id;
        const photo = found.photoUri ?? (hasSample(sampleId) ? await samplePhoto(sampleId).catch(() => null) : null);
        // Boxes where they are on this photo, not on the flat blank form.
        const from = photo && !found.photoUri ? await alignedTo(found, photo) : found;
        const now = Date.now();
        // Its own template beside the built-in, which stays as it is.
        const copy: FormTemplate = {
          ...(JSON.parse(JSON.stringify(from)) as FormTemplate),
          id: `tpl-${newId()}`,
          name: `${from.name} (my copy)`,
          builtinId: undefined,
          anchors: undefined,
          createdAt: now,
          updatedAt: now,
        };
        if (photo) start(photo, { ...copy, photoUri: photo });
        else setSeed(copy);
        return;
      }
      if (params.uri) start(params.uri);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, params.id, params.uri, params.copy]);

  useEffect(() => {
    if (tpl?.photoUri) Image.getSize(tpl.photoUri, (w, h) => setAspect(w / h), () => undefined);
  }, [tpl?.photoUri]);

  const pick = async (source: 'camera' | 'library') => {
    const options: ImagePicker.ImagePickerOptions = { mediaTypes: ['images'], quality: 1, allowsEditing: Platform.OS === 'android' };
    if (source === 'camera' && !(await ImagePicker.requestCameraPermissionsAsync()).granted) return;
    const r = source === 'camera' ? await ImagePicker.launchCameraAsync(options) : await ImagePicker.launchImageLibraryAsync(options);
    if (!r.canceled) start(r.assets[0].uri, seed ? { ...seed, photoUri: r.assets[0].uri } : undefined);
  };

  const taken = useMemo(
    () => new Set([...(tpl?.fields.map((f) => f.id) ?? []), ...(tpl?.tables.flatMap((t) => [t.id, ...(t.orientation === 'rows' ? t.columns.map((x) => x.id) : [])]) ?? [])]),
    [tpl],
  );

  const update = (change: (t: FormTemplate) => FormTemplate) => setTpl((t) => (t ? { ...change(t), updatedAt: Date.now() } : t));
  const rowTables = (tpl?.tables.filter((t) => t.orientation === 'rows') ?? []) as RowTable[];
  const tableOf = (id: string) => rowTables.find((t) => t.id === id)!;
  const setTable = (id: string, change: (t: RowTable) => RowTable) =>
    update((t) => ({ ...t, tables: t.tables.map((x) => (x.id === id && x.orientation === 'rows' ? change(x) : x)) }));

  const chooseKind = (then: (kind: ValueKind) => void) =>
    dialog.actions('What kind of value?', KINDS.map((k) => ({ label: k.label, hint: k.hint, onPress: () => then(k.kind) })));

  // ── Adding things ──

  const addValue = (label: string, rect?: NormRect | null) =>
    chooseKind((kind) => {
      const id = idFor(label, taken);
      const def: FieldDef = { id, label, kind };
      update((t) => ({ ...t, fields: [...t.fields, { ...def, rect: rect ?? { x: 0.3, y: 0.45, w: 0.4, h: 0.05 } }] }));
      setEditing({ kind: 'field', id });
    });

  const addTable = (label: string, rows: number, rect?: NormRect | null) => {
    const id = idFor(label, taken);
    const table: RowTable = { id, label, orientation: 'rows', rect: rect ?? { x: 0.08, y: 0.35, w: 0.84, h: 0.4 }, columns: [], maxRows: Math.max(1, Math.min(60, rows || 10)) };
    update((t) => ({ ...t, tables: [...t.tables, table] }));
    setEditing({ kind: 'rows', table: id });
  };

  const addColumn = (tableId: string, label: string) =>
    chooseKind((kind) => {
      const table = tableOf(tableId);
      const id = idFor(label, taken);
      const r = table.rect!;
      const used = table.columns.reduce((x, col) => Math.max(x, (col.band?.x ?? r.x) + (col.band?.w ?? 0)), r.x);
      const band: Band = { x: Math.min(used, r.x + r.w - 0.08), w: 0.08 };
      setTable(tableId, (t) => ({
        ...t,
        // The first column added is the key: it tells rows apart (a name, a number).
        key: t.key ?? (kind === 'text' || kind === 'integer' ? id : undefined),
        columns: [...t.columns, { id, label, kind, band }],
      }));
      setEditing({ kind: 'column', table: tableId, column: id });
    });

  const addCheck = (label: string, rule: string) => {
    let names: string[];
    try {
      names = namesIn(parseRule(rule));
    } catch (e) {
      return void dialog.notice('That rule can’t be read', `${e instanceof Error ? e.message : String(e)}\n\nWrite it like: total == a + b, or temp <= 70.`);
    }
    const ids = names.map((n) => n.split('.')[0]);
    const table = rowTables.find((t) => ids.some((id) => t.columns.some((col) => col.id === id)));
    const known = new Set([...tpl!.fields.map((f) => f.id), ...(table?.columns.map((col) => col.id) ?? [])]);
    const unknown = ids.filter((id) => !known.has(id));
    if (unknown.length) return void dialog.notice('Unknown names', `${unknown.join(', ')} ${unknown.length === 1 ? 'isn’t a value' : 'aren’t values'} on this template. The names are listed under each value.`);
    update((t) => ({ ...t, checks: [...t.checks, { id: idFor(label, new Set(t.checks.map((x) => x.id))), label: label || rule, rule, ...(table ? { table: table.id } : {}) }] }));
  };

  const removeField = (id: string) => update((t) => ({ ...t, fields: t.fields.filter((f) => f.id !== id) }));
  const removeTable = (id: string) => update((t) => ({ ...t, tables: t.tables.filter((x) => x.id !== id) }));
  const removeColumn = (table: string, id: string) =>
    setTable(table, (t) => ({ ...t, columns: t.columns.filter((x) => x.id !== id), key: t.key === id ? undefined : t.key }));

  const confirmRemove = (what: string, then: () => void) =>
    void dialog.confirm({ title: `Remove ${what}?`, confirm: 'Remove', destructive: true }).then((ok) => ok && then());

  // ── Saving ──

  const save = async () => {
    if (!tpl?.photoUri) return;
    const columns = rowTables.reduce((n, t) => n + t.columns.length, 0);
    if (!tpl.fields.length && !columns) return void dialog.notice('Nothing to read yet', 'Add at least one value or a table with a column.');
    setSaving(true);
    try {
      // Keep the photo, and its printed words, so later photos of this form line up.
      const photoUri = tpl.photoUri.includes('/pages/') ? tpl.photoUri : keepImage(tpl.photoUri, `template-${tpl.id}`, 'photo');
      const lines = await recognizePageText(photoUri).catch(() => null);
      const withAnchors = newFormTemplate(tpl, tpl.id, tpl.name, photoUri, lines, tpl.createdAt);
      await saveTemplate(db, { ...withAnchors, id: tpl.id, updatedAt: Date.now() });
      router.replace({ pathname: '/template/[id]', params: { id: tpl.id } });
    } finally {
      setSaving(false);
    }
  };

  // ── No photo yet ──

  if (!tpl) {
    // Opened to copy a built-in: wait for it to load before asking for a photo.
    if (params.copy && !seed) return <View style={[base.screen, { backgroundColor: c.bg }]} />;
    const what = seed?.name.replace(/ \(my copy\)$/, '') ?? params.name;
    return (
      <View style={[base.screen, base.content, { backgroundColor: c.bg }]}>
        <Stack.Screen options={{ title: 'Build a template' }} />
        <T style={styles.question}>{what ? `Photograph a ${what}` : 'Photograph the form'}</T>
        <T muted style={styles.lead}>Filled in is best: you’ll see where people write. Flat, in good light, the whole page in the frame.</T>
        <Button title="Take a photo" size="lg" onPress={() => void pick('camera')} />
        <Button title="Choose from Photos" kind="secondary" onPress={() => void pick('library')} />
      </View>
    );
  }

  // ── Shapes on the page ──

  const naming = !!drawn && (asking?.kind === 'value' || asking?.kind === 'table');
  const shapes: MarkerShape[] = [...shapesOf(tpl), ...(naming ? [{ id: 'new', rect: drawn!, color: FIELD, label: 'New box' }] : [])];
  const activeId = editing?.kind === 'field' ? `f:${editing.id}` : editing?.kind === 'rows' ? `t:${editing.table}` : editing ? `c:${editing.table}:${editing.column}` : null;
  const active = shapes.find((s) => s.id === activeId) ?? null;
  const band = editing?.kind === 'column' ? (({ y, h }) => ({ y, h }))(tableOf(editing.table).rect!) : null;

  const onChange = (rect: NormRect, lean?: number) => {
    if (!editing) return;
    if (editing.kind === 'field') update((t) => ({ ...t, fields: t.fields.map((f) => (f.id === editing.id ? { ...f, rect } : f)) }));
    else if (editing.kind === 'rows') setTable(editing.table, (t) => ({ ...t, rect }));
    else setTable(editing.table, (t) => ({ ...t, columns: t.columns.map((col) => (col.id === editing.column ? { ...col, band: bandOf(rect.x, rect.w, lean) } : col)) }));
  };

  const onTapShape = (id: string) => {
    const [k, a, b] = id.split(':');
    // A sideways table's boxes (copied from a built-in) are shown but not changed here.
    if (k === 'f') setEditing({ kind: 'field', id: a });
    else if (k === 't' && rowTables.some((t) => t.id === a)) setEditing({ kind: 'rows', table: a });
    else if (k === 'c') setEditing({ kind: 'column', table: a, column: b });
  };

  /** A box drawn with nothing selected: ask what it is. A big one is most likely a table. */
  const onDraw = (rect: NormRect) => {
    const name = (kind: 'value' | 'table') => () => {
      setDrawn(rect);
      setAsking({ kind });
    };
    const value = { label: 'A value', hint: 'One thing written here: a lot number, a date, a reading', onPress: name('value') };
    const table = { label: 'A table’s rows', hint: 'Rows of the same values, one per line. Box the rows, not the headings', onPress: name('table') };
    dialog.actions('What did you box?', rect.w > 0.4 && rect.h > 0.12 ? [table, value] : [value, table]);
  };

  const hint =
    editing?.kind === 'field'
      ? 'Drag the box over where this value is written, or draw a new one. Pinch to zoom.'
      : editing?.kind === 'rows'
        ? 'Box the table’s rows, from the first to the last. Leave out the printed headings.'
        : editing?.kind === 'column'
          ? 'Drag the column over this value’s column. If it leans, drag the white handle at its top or bottom sideways.'
          : 'Drag on the page to box a value or a table’s rows. Tap a box to change it.';

  const sheet: { title: string; fields: SheetField[]; onSave: (d: Record<string, string>) => void } | null =
    asking?.kind === 'value'
      ? { title: 'Add a value', fields: [{ key: 'label', label: 'Its label on the form', value: '', placeholder: 'Lot No.' }], onSave: (d) => d.label.trim() && addValue(d.label.trim(), drawn) }
      : asking?.kind === 'table'
        ? {
            title: 'Add a table',
            fields: [
              { key: 'label', label: 'What the table is', value: '', placeholder: 'Cylinders', flex: 2 },
              { key: 'rows', label: 'Rows on the form', value: '10', numeric: true },
            ],
            onSave: (d) => d.label.trim() && addTable(d.label.trim(), Number(d.rows), drawn),
          }
        : asking?.kind === 'column'
          ? { title: 'Add a column', fields: [{ key: 'label', label: 'Its heading on the form', value: '', placeholder: 'Strength' }], onSave: (d) => d.label.trim() && addColumn(asking.table, d.label.trim()) }
          : asking?.kind === 'name'
            ? { title: 'Template name', fields: [{ key: 'name', label: 'Name', value: tpl.name }], onSave: (d) => d.name.trim() && update((t) => ({ ...t, name: d.name.trim() })) }
            : asking?.kind === 'check'
              ? {
                  title: 'Add a check',
                  fields: [
                    { key: 'label', label: 'What it checks', value: '', placeholder: 'Strength = load / area' },
                    { key: 'rule', label: 'Rule, using the value names', value: '', placeholder: 'strength == maxLoad / area' },
                  ],
                  onSave: (d) => d.rule.trim() && addCheck(d.label.trim(), d.rule.trim()),
                }
              : null;

  return (
    <View style={[base.screen, { backgroundColor: c.bg }]}>
      <Stack.Screen options={{ title: tpl.name }} />
      {tpl.photoUri && (
        <PageMarker
          uri={tpl.photoUri}
          aspect={aspect}
          width={screenW}
          height={Math.round(screenH * (editing ? 0.58 : 0.45))}
          shapes={shapes}
          active={active}
          band={band}
          onChange={editing ? onChange : undefined}
          onTapShape={onTapShape}
          showLabels
          allowDraw={editing ? editing.kind !== 'column' : true}
          onDraw={editing ? undefined : onDraw}
        />
      )}
      {!editing && <T muted style={[base.small, styles.tip]}>{hint}</T>}

      {editing ? (
        <View style={[base.content, { flex: 1 }]}>
          <T style={base.h2}>{active?.label ?? ''}</T>
          <T muted style={styles.lead}>{hint}</T>
          <View style={{ flex: 1 }} />
          {editing.kind === 'rows' && (
            <Button title="Add its first column" kind="secondary" onPress={() => setAsking({ kind: 'column', table: editing.table })} />
          )}
          <View style={{ paddingBottom: insets.bottom }}>
            <Button title="Done" size="lg" onPress={() => setEditing(null)} />
          </View>
        </View>
      ) : (
        <>
          <ScrollView contentContainerStyle={[base.content, { paddingBottom: 140 }]}>
            <Pressable onPress={() => setAsking({ kind: 'name' })} accessibilityRole="button" style={[base.row, { justifyContent: 'space-between' }]}>
              <T style={[base.h2, { flex: 1 }]}>{tpl.name}</T>
              <T style={{ color: c.accent, fontFamily: fonts.bodySemiBold }}>Rename</T>
            </Pressable>

            <Card style={styles.list}>
              <T style={[base.h2, styles.head]}>Values</T>
              {tpl.fields.map((f) => (
                <Item key={f.id} color={FIELD} title={f.label} sub={`${f.id} · ${KINDS.find((k) => k.kind === f.kind)?.label}`} onPress={() => setEditing({ kind: 'field', id: f.id })} onRemove={() => confirmRemove(f.label, () => removeField(f.id))} />
              ))}
              <Add label="+ Add a value" onPress={() => setAsking({ kind: 'value' })} />
            </Card>

            {rowTables.map((t) => (
              <Card key={t.id} style={styles.list}>
                <Item color={TABLE} title={t.label} sub={`Table · up to ${t.maxRows} rows · tap to move its box`} onPress={() => setEditing({ kind: 'rows', table: t.id })} onRemove={() => confirmRemove(`the ${t.label} table`, () => removeTable(t.id))} />
                {t.columns.map((col) => (
                  <Item
                    key={col.id}
                    color={COLUMN}
                    indent
                    title={`${col.label}${t.key === col.id ? '  (tells rows apart)' : ''}`}
                    sub={`${col.id} · ${KINDS.find((k) => k.kind === col.kind)?.label}`}
                    onPress={() => setEditing({ kind: 'column', table: t.id, column: col.id })}
                    onRemove={() => confirmRemove(col.label, () => removeColumn(t.id, col.id))}
                  />
                ))}
                <Add label="+ Add a column" onPress={() => setAsking({ kind: 'column', table: t.id })} />
              </Card>
            ))}
            <Button title="+ Add a table" kind="secondary" onPress={() => setAsking({ kind: 'table' })} />

            <Card style={styles.list}>
              <T style={[base.h2, styles.head]}>Checks</T>
              {tpl.checks.map((ch) => (
                <Item key={ch.id} color={c.muted} title={ch.label} sub={ch.rule} onRemove={() => confirmRemove(ch.label, () => update((t) => ({ ...t, checks: t.checks.filter((x) => x.id !== ch.id) })))} />
              ))}
              <Add label="+ Add a check" onPress={() => setAsking({ kind: 'check' })} />
              <T muted style={[base.small, styles.head]}>Rules use the names under each value: total == a + b, temp &lt;= 70, ceil(n / 2). Numbers are also checked against their range.</T>
            </Card>
          </ScrollView>
          <View style={[styles.footer, { backgroundColor: c.bg, borderTopColor: c.border, paddingBottom: space.md + insets.bottom }]}>
            <Button title="Save template" size="lg" busy={saving} onPress={() => void save()} />
          </View>
        </>
      )}

      <EditSheet visible={!!sheet} title={sheet?.title ?? ''} fields={sheet?.fields ?? []} onClose={() => { setAsking(null); setDrawn(null); }} onSave={(d) => { setAsking(null); setDrawn(null); sheet?.onSave(d); }} />
    </View>
  );
}

function Item({ color, title, sub, onPress, onRemove, indent }: { color: string; title: string; sub: string; onPress?: () => void; onRemove: () => void; indent?: boolean }) {
  const c = useColors();
  return (
    <Pressable onPress={onPress} onLongPress={onRemove} accessibilityRole="button" accessibilityHint="Press and hold to remove" style={({ pressed }) => [styles.item, { borderTopColor: c.border, paddingLeft: indent ? 34 : 14, backgroundColor: pressed ? c.sunken : 'transparent' }]}>
      <View style={[styles.swatch, { backgroundColor: color }]} />
      <View style={{ flex: 1, gap: 1 }}>
        <T style={{ fontSize: 15 }}>{title}</T>
        <T muted style={{ fontSize: 12.5, fontFamily: fonts.mono }}>{sub}</T>
      </View>
    </Pressable>
  );
}

function Add({ label, onPress }: { label: string; onPress: () => void }) {
  const c = useColors();
  return (
    <Pressable onPress={onPress} accessibilityRole="button" style={[styles.item, { borderTopColor: c.border }]}>
      <T style={{ color: c.accent, fontFamily: fonts.bodySemiBold }}>{label}</T>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  question: { fontSize: 22, fontFamily: fonts.headingBold, letterSpacing: -0.2 },
  lead: { fontSize: 15, lineHeight: 21 },
  list: { padding: 0, gap: 0, overflow: 'hidden' },
  tip: { paddingHorizontal: space.lg, paddingTop: space.sm },
  head: { paddingHorizontal: 14, paddingVertical: 10 },
  item: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 10, borderTopWidth: 1, minHeight: 48 },
  swatch: { width: 10, height: 10, borderRadius: 2 },
  footer: { position: 'absolute', left: 0, right: 0, bottom: 0, padding: space.lg, borderTopWidth: 1 },
});
