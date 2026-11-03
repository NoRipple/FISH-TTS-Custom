// Group and bulk-operation logic for the voice panel. Kept free of DOM and
// settings access so every rule here is testable with node alone.

// A group is only a label. Membership lives on each voice entry (`group`), so a
// voice can never be half-in and half-out of a group, and deleting a group can
// never delete a voice.
export function normalizeGroupName(value) {
    return typeof value === 'string' ? value.trim() : '';
}

export function normalizeGroups(value) {
    const list = Array.isArray(value) ? value : [];
    const out = [];
    for (const item of list) {
        const name = normalizeGroupName(item);
        if (name && !out.includes(name)) out.push(name);
    }
    return out;
}

// Groups are ordered by first appearance in the library so an import keeps its
// natural order, with explicitly declared but still-empty groups appended.
export function collectGroupNames(library, declared) {
    const out = normalizeGroups(declared);
    for (const entry of Array.isArray(library) ? library : []) {
        const name = normalizeGroupName(entry?.group);
        if (name && !out.includes(name)) out.push(name);
    }
    return out;
}

// Group is shared by every entry carrying the same id (a voice can appear twice
// if it was both synced and imported). Updating all of them keeps the library
// consistent instead of leaving a stale duplicate in the old group.
export function assignGroup(library, ids, group) {
    const target = normalizeGroupName(group);
    const set = new Set(Array.isArray(ids) ? ids : []);
    const entries = Array.isArray(library) ? library : [];
    let changed = 0;
    for (const entry of entries) {
        if (!entry || !set.has(entry.id)) continue;
        if (normalizeGroupName(entry.group) !== target) { entry.group = target; changed++; }
    }
    return changed;
}

export function setActive(library, ids, active) {
    const set = new Set(Array.isArray(ids) ? ids : []);
    const flag = active !== false;
    let changed = 0;
    for (const entry of Array.isArray(library) ? library : []) {
        if (!entry || !set.has(entry.id)) continue;
        if ((entry.active !== false) !== flag) { entry.active = flag; changed++; }
    }
    return changed;
}

export function removeEntries(library, ids) {
    const set = new Set(Array.isArray(ids) ? ids : []);
    return (Array.isArray(library) ? library : []).filter(entry => !(entry && set.has(entry.id)));
}

// Empty string is the "未分组" bucket, which is always shown last.
export function groupEntries(library, groups) {
    const names = collectGroupNames(library, groups);
    const buckets = names.map(name => ({ name, entries: [] }));
    const loose = [];
    for (const entry of Array.isArray(library) ? library : []) {
        if (!entry) continue;
        const name = normalizeGroupName(entry.group);
        const bucket = name ? buckets.find(b => b.name === name) : null;
        (bucket ? bucket.entries : loose).push(entry);
    }
    return { buckets, loose };
}

export function toggleAll(library, ids, mode = 'toggle') {
    const set = new Set(Array.isArray(ids) ? ids : []);
    const targets = (Array.isArray(library) ? library : []).filter(entry => entry && set.has(entry.id));
    const allActive = targets.length > 0 && targets.every(entry => entry.active !== false);
    const desired = mode === 'enable' ? true : mode === 'disable' ? false : !allActive;
    return setActive(library, [...set], desired);
}

// A group added by the user is kept even while empty so it survives a sync that
// returns no members; renames rewrite both the list and every member.
export function addGroup(declared, name) {
    const value = normalizeGroupName(name);
    if (!value) throw new Error('组名不能为空');
    const groups = normalizeGroups(declared);
    if (groups.includes(value)) throw new Error('该组已存在');
    return groups.concat([value]);
}

export function renameGroup(library, declared, from, to) {
    const oldName = normalizeGroupName(from), newName = normalizeGroupName(to);
    if (!newName) throw new Error('组名不能为空');
    if (oldName === newName) return { groups: normalizeGroups(declared), changed: 0 };
    let groups = normalizeGroups(declared);
    if (groups.includes(newName)) throw new Error('该组已存在');
    groups = groups.map(name => name === oldName ? newName : name);
    if (!groups.includes(newName)) groups.push(newName);
    const changed = assignGroup(library, (library || []).filter(e => normalizeGroupName(e?.group) === oldName).map(e => e.id), newName);
    return { groups, changed };
}

// Deleting a group moves its members to 未分组 rather than deleting voices; the
// user asked to reorganise, not to lose a library.
export function deleteGroup(library, declared, name) {
    const target = normalizeGroupName(name);
    if (!target) throw new Error('组名不能为空');
    const groups = normalizeGroups(declared).filter(item => item !== target);
    let moved = 0;
    for (const entry of Array.isArray(library) ? library : []) {
        if (!entry || normalizeGroupName(entry.group) !== target) continue;
        entry.group = ''; moved++;
    }
    return { groups, moved };
}

// Membership is derived, never stored twice, so a group badge can be computed
// from the library at any time without a counter to drift out of sync.
export function groupSummary(library, groups) {
    const { buckets, loose } = groupEntries(library, groups);
    const describe = list => ({ total: list.length, active: list.filter(e => e.active !== false).length });
    return {
        groups: buckets.map(bucket => ({ name: bucket.name, ...describe(bucket.entries) })),
        ungrouped: describe(loose),
        total: (library || []).filter(Boolean).length,
        active: (library || []).filter(e => e && e.active !== false).length,
    };
}
