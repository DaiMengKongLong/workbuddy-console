/**
 * 登录态与目录的权限自检。
 *
 * 工具会**写**这些位置：登录态文件（切换账号 / 恢复备份）、WorkBuddy 的
 * models.json（载入模型）、`~/.wb-switch/accounts.json`（账号库）与备份目录。
 * 一旦某个目录只读（被安全软件锁、权限不足、文件被占用），表现为"点了没反应"，
 * 这里把可读写状态显式列出来，让用户能第一时间定位原因。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { VARIANT_LIST, authFilePath, dataRoot } from './variant.mjs';
import { sessionDataRoot } from './sessions.mjs';
import { STORE_DIR, ACCOUNTS_FILE, BACKUP_DIR } from './accounts.mjs';
import { CONFIG_DIR, CONFIG_FILE } from '../store/config.mjs';

/**
 * 探测单个路径的读写权限。
 *
 * 文件用 `r+` 实际打开一次——比 `access(W_OK)` 更接近真实写入场景：只读属性、
 * 被其他进程独占（WorkBuddy 正持有登录态文件）都会在这里暴露出来。
 * 目录用 R_OK/W_OK 探测。不存在时不报错，交给上层按"未创建"处理。
 */
function probe(target, { kind = 'file' } = {}) {
  const result = { path: target, exists: false, readable: false, writable: false, kind, error: null };
  try {
    result.exists = fs.existsSync(target);
  } catch (e) {
    result.error = e?.message || String(e);
    return result;
  }
  if (!result.exists) return result;

  if (kind === 'file') {
    try {
      const fd = fs.openSync(target, 'r+');
      fs.closeSync(fd);
      result.readable = true;
      result.writable = true;
      return result;
    } catch (e) {
      // 打开失败：可能是只读，也可能只是被占用；再分别探测读权限
      result.error = e?.code === 'EBUSY' || e?.code === 'EPERM' ? '文件可能正被其他程序占用' : e?.message || String(e);
    }
  }
  try {
    fs.accessSync(target, fs.constants.R_OK);
    result.readable = true;
  } catch {
    result.readable = false;
  }
  try {
    fs.accessSync(target, fs.constants.W_OK);
    result.writable = true;
  } catch {
    result.writable = false;
  }
  return result;
}

/** 探测"目录可写"：不存在时用最近存在的父目录推断，能创建即视为可写 */
function probeDirWritable(dir) {
  let cur = dir;
  while (cur && !fs.existsSync(cur)) {
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  const base = probe(cur, { kind: 'dir' });
  return {
    path: dir,
    exists: fs.existsSync(dir),
    readable: base.readable,
    writable: base.writable,
    kind: 'dir',
    error: base.error,
    checkedAncestor: cur,
  };
}

/**
 * 逐项自检。
 * 返回 { items: [...], ok: 全部通过 }
 */
export function checkPermissions() {
  const items = [];

  // 1. 两档位的登录态文件
  for (const v of VARIANT_LIST) {
    const p = authFilePath(v);
    const stat = probe(p, { kind: 'file' });
    items.push({
      id: `auth-${v.id}`,
      group: '登录态文件',
      label: `${v.label}登录态`,
      path: p,
      exists: stat.exists,
      readable: stat.readable,
      writable: stat.writable,
      required: 'read-write',
      hint: stat.exists
        ? '切换账号与恢复备份会写入此文件；需可读写。'
        : '尚未登录过该档位，登录 WorkBuddy 后会自动生成。',
      ok: stat.exists ? stat.readable && stat.writable : true,
    });
  }

  // 2. WorkBuddy 数据目录（models.json/workbuddy.db 实际写入目标）。
  // ⚠️ 必须用 sessionDataRoot()（国内版含 settings.workbuddyDir 覆盖），此前固定用
  // dataRoot()——设置过自定义数据目录的机器上自检探的是没人写的目录，纯误导（M12）
  {
    const seen = new Set();
    for (const v of VARIANT_LIST) {
      const dir = sessionDataRoot(v.id);
      if (seen.has(dir)) continue; // 两档位指向同一目录时只报一次
      seen.add(dir);
      const stat = probeDirWritable(dir);
      items.push({
        id: `data-${v.id}`,
        group: 'WorkBuddy 数据目录',
        label: `${v.label}数据目录`,
        path: dir,
        exists: stat.exists,
        readable: stat.readable,
        writable: stat.writable,
        required: 'read-write',
        hint: stat.exists ? '载入模型会写入此目录下的 models.json，会话操作读写 workbuddy.db。' : '该档位尚未使用过（目录不存在）。',
        ok: stat.exists ? stat.writable : true,
      });
    }
  }

  // 3. 账号库（与 workbuddy-switch 共用）
  const store = probeDirWritable(STORE_DIR);
  items.push({
    id: 'store-dir',
    group: '账号库',
    label: '账号库目录',
    path: STORE_DIR,
    exists: store.exists,
    readable: store.readable,
    writable: store.writable,
    required: 'read-write',
    hint: '账号列表保存在 accounts.json，增删改账号需要写权限。',
    ok: store.writable || !store.exists,
  });
  const accountsFile = probe(ACCOUNTS_FILE, { kind: 'file' });
  items.push({
    id: 'accounts-file',
    group: '账号库',
    label: 'accounts.json',
    path: ACCOUNTS_FILE,
    exists: accountsFile.exists,
    readable: accountsFile.readable,
    writable: accountsFile.writable,
    required: 'read-write',
    hint: accountsFile.exists ? '账号数据文件。' : '尚未创建，首次添加账号时生成。',
    ok: accountsFile.exists ? accountsFile.readable && accountsFile.writable : true,
  });

  // 4. 备份目录
  const backup = probeDirWritable(BACKUP_DIR);
  items.push({
    id: 'backup-dir',
    group: '备份',
    label: '登录态备份目录',
    path: BACKUP_DIR,
    exists: backup.exists,
    readable: backup.readable,
    writable: backup.writable,
    required: 'read-write',
    hint: '每次切换账号前都会在此存一份原登录态，用于回滚。',
    ok: backup.writable || !backup.exists,
  });

  // 5. 工具自身配置目录
  const cfgDir = probeDirWritable(CONFIG_DIR);
  items.push({
    id: 'config-dir',
    group: '工具配置',
    label: '配置目录',
    path: CONFIG_DIR,
    exists: cfgDir.exists,
    readable: cfgDir.readable,
    writable: cfgDir.writable,
    required: 'read-write',
    hint: '平台 Key 与代理等设置保存在 config.json。',
    ok: cfgDir.writable || !cfgDir.exists,
  });
  const cfgFile = probe(CONFIG_FILE, { kind: 'file' });
  items.push({
    id: 'config-file',
    group: '工具配置',
    label: 'config.json',
    path: CONFIG_FILE,
    exists: cfgFile.exists,
    readable: cfgFile.readable,
    writable: cfgFile.writable,
    required: 'read-write',
    hint: cfgFile.exists ? '平台 Key 数据文件。' : '尚未创建，首次保存设置时生成。',
    ok: cfgFile.exists ? cfgFile.readable && cfgFile.writable : true,
  });

  return {
    ok: items.every((i) => i.ok),
    platform: process.platform,
    home: os.homedir(),
    items,
  };
}
