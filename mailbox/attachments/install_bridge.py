#!/usr/bin/env python3
"""Install the Muse bridge attachments on its Linux VM as the Hatch service user.

plan/install use --desktop-hook-id ID --qq-chats Q1 Q2 Q3 --desktop-chats D1 D2 D3.
Optionally pass --main-chat-id ID and --hook-inventory FILE (a JSON array of existing
hook definitions copied from the platform). No credentials or platform API are used.
Repeat the same install command to resume an interrupted copy. For rollback use
rollback with the transaction ID printed at installation.
"""
import argparse
from contextlib import ExitStack, contextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import uuid


HOME = Path.home().resolve()
SOURCE = Path(__file__).resolve().parent
TOOLS = Path("workspace/bridge-tools")
HISTORY = HOME / TOOLS / ".install-history"
CHANNELS = ("qq", "desktop")
RUNTIME = ("bridge_runtime.py", "bridge_consume.sh", "bridge_dispatch.py", "bridge_delivery.py",
           "bridge_watch.py", "board_aggregate.py", "board_sources.py", "pipeline_signals.py")
HOOK_FIELDS = ("id", "script_path", "poll_interval_secs", "script_timeout_secs", "delivery", "prompt", "enabled")


def fail(message):
    raise ValueError(message)


def encode(obj):
    return (json.dumps(obj, ensure_ascii=False, indent=2, allow_nan=False) + "\n").encode()


def dir_sync(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def atomic_file(path, data, mode, group=None):
    fd, name = tempfile.mkstemp(dir=path.parent, prefix=".bridge-install-")
    try:
        with os.fdopen(fd, "wb") as output:
            output.write(data)
            if group is not None and os.fstat(output.fileno()).st_gid != group:
                os.fchown(output.fileno(), -1, group)
            os.fchmod(output.fileno(), mode)
            output.flush()
            os.fsync(output.fileno())
        os.replace(name, path)
        dir_sync(path.parent)
    finally:
        Path(name).unlink(missing_ok=True)


def local_path(relative):
    relative = Path(relative)
    path = HOME / relative
    parent = path.parent.resolve()
    if relative.is_absolute() or ".." in relative.parts or (parent != HOME and HOME not in parent.parents):
        fail("安装目标超出 Hatch 家目录")
    return path


def fingerprint(data, mode):
    return {"sha256": hashlib.sha256(data).hexdigest(), "mode": mode}


def file_state(path):
    try:
        info = path.lstat()
    except FileNotFoundError:
        return None
    if info.st_uid != os.geteuid():
        fail(f"文件属主与运行账号不同：{path}")
    if stat.S_ISLNK(info.st_mode):
        return {"link": os.readlink(path)}
    if not stat.S_ISREG(info.st_mode):
        fail(f"目标不是普通文件或符号链接：{path}")
    return fingerprint(path.read_bytes(), stat.S_IMODE(info.st_mode))


def identifier(value):
    if not value or value != value.strip() or not value.isprintable() or "<" in value or ">" in value:
        fail("请提供平台返回的实际 ID")
    return value


def shipped_files():
    for name in RUNTIME:
        yield name, str(TOOLS / name), 0o700
    name = "muse-bridge-receiver@.service"
    yield name, str(TOOLS / name), 0o600
    for name in ("pipeline_view.css", "pipeline_view.mjs"):
        yield name, str(TOOLS / "page-assets" / name), 0o600
    for channel in CHANNELS:
        prompt = f"src-hook-{channel}-prompt.md"
        yield prompt, str(TOOLS / "hatch-hooks" / prompt), 0o600
        yield f"src-{channel}-ship_relay.py", f"workspace/{channel}-bridge/ship_relay.py", 0o700


def hook_paths(channel, slot):
    return (f"hooks/scripts/{channel}-bridge-slot-{slot}.sh",
            str(TOOLS / "hatch-hooks" / f"{channel}-{slot}.json"))


def bundle(args):
    files = {path: ((SOURCE / name).read_text(encoding="utf-8").encode(), mode) for name, path, mode in shipped_files()}
    all_chats = [identifier(value) for value in args.qq_chats + args.desktop_chats]
    if (len(set(all_chats)) != 6 or any(chat.casefold() == "main" for chat in all_chats)
            or args.main_chat_id in all_chats):
        fail("六个工位需要六个不同的 side_chat，主聊天不能作为接单工位")
    definitions = {}
    originals = set()
    for channel in CHANNELS:
        base = identifier(getattr(args, channel + "_hook_id"))
        if base in originals:
            fail("两个原 hook 的 ID 相同")
        originals.add(base)
        prompt_name = f"src-hook-{channel}-prompt.md"
        prompt = files[str(TOOLS / "hatch-hooks" / prompt_name)][0].decode()
        for slot, chat in enumerate(getattr(args, channel + "_chats"), 1):
            hook_id = base if slot == 1 else f"{base}-{slot}"
            if hook_id in definitions:
                fail("工位 hook ID 冲突")
            script, config = hook_paths(channel, slot)
            entry = '#!/usr/bin/env bash\nexec bash "$HOME/workspace/bridge-tools/bridge_consume.sh"'
            files[script] = ((entry + f" {channel} {slot}\n").encode(), 0o700)
            definition = {"id": hook_id, "script_path": "~/" + script, "poll_interval_secs": 5,
                          "script_timeout_secs": 600, "delivery": [{"surface": "side_chat", "to": chat}],
                          "prompt": prompt, "enabled": False}
            definitions[hook_id] = definition
            files[config] = (encode(definition), 0o600)
    previous = []
    if args.hook_inventory:
        items = json.loads(Path(args.hook_inventory).read_text(encoding="utf-8"))
        if not isinstance(items, list):
            fail("hook 清单应为从平台复制的真实定义组成的 JSON 数组")
        seen = set()
        for hook in items:
            if (not isinstance(hook, dict) or not isinstance(hook.get("id"), str)
                    or not isinstance(hook.get("delivery"), list) or not all(isinstance(d, dict) for d in hook["delivery"])):
                fail("hook 清单不含完整 id 或 delivery")
            hook_id = hook["id"]
            if hook_id in seen:
                fail("hook 清单有重复 ID")
            seen.add(hook_id)
            desired = definitions.get(hook_id)
            if desired and hook_id not in originals and (hook.get("script_path") != desired["script_path"]
                                                          or hook["delivery"] != desired["delivery"]):
                fail(f"平台已有无关的同名 hook：{hook_id}")
            if not desired and any(d.get("surface") == "side_chat" and d.get("to") in all_chats for d in hook["delivery"]):
                fail(f"侧聊已绑定其他 hook：{hook_id}")
            if desired:
                if any(field not in hook for field in HOOK_FIELDS):
                    fail(f"需要 {hook_id} 的完整 view 定义才能归档")
                previous.append({field: hook[field] for field in HOOK_FIELDS})
        if not originals.issubset(seen):
            fail("清单缺少要原地更新的 QQ 或桌面原 hook")
    return files, previous


def preflight(files):
    for command in ("bash", "jq"):
        if not shutil.which(command):
            fail(f"VM 缺少 {command}")
    for channel in CHANNELS:
        if not local_path(f"workspace/{channel}-bridge").is_dir():
            fail(f"找不到现有 {channel} 桥，请以运行 Hatch 的账号执行")
    client = HOME / "workspace/custom-connectors/custom.huiyu-relay-main/bin/client.py"
    if not client.is_file() or not os.access(client, os.R_OK):
        fail("找不到可读取的主力机中转客户端")
    destinations = set()
    for relative in files:
        path = local_path(relative)
        destination = path.parent.resolve() / path.name
        if destination in destinations:
            fail(f"安装目录有路径冲突：{relative}")
        destinations.add(destination)
        parent = path.parent
        while not parent.exists():
            parent = parent.parent
        if not parent.is_dir() or not os.access(parent, os.W_OK | os.X_OK):
            fail(f"无法写入：{parent}")
        file_state(path)


@contextmanager
def install_locks():
    with ExitStack() as stack:
        for channel in CHANNELS:
            state = local_path(f"hooks/state/{channel}-bridge")
            state.mkdir(mode=0o700, exist_ok=True, parents=True)
            for name in ("poll.lock", "ship-watch.lock"):
                lock = stack.enter_context((state / name).open("a+b"))
                try:
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError:
                    fail(f"{channel} 的 {name} 正在使用。请先停旧轮询和发货看守，等正在处理的请求结束")
        yield


def transactions():
    records = []
    for path in HISTORY.glob("*/manifest.json"):
        records.append((path.parent, json.loads(path.read_text(encoding="utf-8"))))
    return sorted(records, key=lambda entry: entry[0].name)


def write_manifest(run, log):
    atomic_file(run / "manifest.json", encode(log), 0o600)


def prepare(files, previous, identity):
    run = HISTORY / f"{time.time_ns()}-{uuid.uuid4().hex[:8]}"
    run.mkdir(mode=0o700)
    entries = []
    for path, (data, mode) in files.items():
        target = local_path(path)
        before = file_state(target)
        after = fingerprint(data, mode)
        if before == after:
            continue
        backup = f"old-{len(entries)}"
        if before and "sha256" in before:
            original = target.read_bytes()
            if hashlib.sha256(original).hexdigest() != before["sha256"]:
                fail(f"备份时文件发生变化：{target}")
            atomic_file(run / backup, original, 0o600)
        entries.append({"path": path, "before": before, "after": after, "backup": backup,
                        "oldGroup": target.lstat().st_gid if before else None})
    if previous:
        atomic_file(run / "previous-hooks.json", encode(previous), 0o600)
    record = {
        "id": run.name, "state": "installing", "bundle": identity, "files": entries,
        "resume": "用相同附件和安装参数再次执行 install。",
        "rollback": f"禁用六个 hook，停收发看守并核对未确认投递，运行 install_bridge.py rollback {run.name}。"
                    "仅恢复软件文件；在 Hatch 恢复安装前 view 保存的绑定和启用状态，停用本次新增工位。",
    }
    write_manifest(run, record)
    dir_sync(HISTORY)
    return run, record


def verify(entries):
    allowed = {dest for _, dest, _ in shipped_files()}
    for channel in CHANNELS:
        for slot in (1, 2, 3):
            allowed.update(hook_paths(channel, slot))
    for index, entry in enumerate(entries):
        if entry["path"] not in allowed or entry["backup"] != f"old-{index}":
            fail("安装历史与受管理文件清单不符")
        actual = file_state(local_path(entry["path"]))
        if actual not in (entry["before"], entry["after"]):
            fail(f"文件已被另外修改，请先保留并核对：{entry['path']}")


def rollback(run, record):
    entries = record["files"]
    verify(entries)
    for item in entries:
        old = item["before"]
        if old and "sha256" in old and hashlib.sha256((run / item["backup"]).read_bytes()).hexdigest() != old["sha256"]:
            fail(f"备份校验失败：{item['path']}")
    record["state"] = "rolling_back"
    write_manifest(run, record)
    for item in reversed(entries):
        path, old = local_path(item["path"]), item["before"]
        current = file_state(path)
        if current == old:
            continue
        if current != item["after"]:
            fail(f"回退时文件发生变化：{path}")
        if old is None:
            path.unlink()
        elif "link" in old:
            with tempfile.TemporaryDirectory(dir=path.parent) as tmp:
                link = Path(tmp) / "original"
                link.symlink_to(old["link"])
                if link.lstat().st_gid != item["oldGroup"]:
                    os.lchown(link, -1, item["oldGroup"])
                os.replace(link, path)
        else:
            atomic_file(path, (run / item["backup"]).read_bytes(), old["mode"], item["oldGroup"])
        dir_sync(path.parent)
    record["state"] = "rolled_back"
    write_manifest(run, record)
    print("已恢复安装前的文件。请在 Hatch 恢复之前保存的配置和启用状态；保留全部收件、回执和截止标记。")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    modes = parser.add_subparsers(dest="command", required=True)
    for name in ("plan", "install"):
        sub = modes.add_parser(name)
        sub.add_argument("--qq-hook-id", default="qq-bridge-answer")
        sub.add_argument("--desktop-hook-id", required=True)
        sub.add_argument("--qq-chats", nargs=3, required=True)
        sub.add_argument("--desktop-chats", nargs=3, required=True)
        sub.add_argument("--main-chat-id")
        sub.add_argument("--hook-inventory")
    modes.add_parser("rollback").add_argument("transaction")
    args = parser.parse_args()
    os.umask(0o077)
    if args.command != "rollback":
        files, previous = bundle(args)
        preflight(files)
        identity = hashlib.sha256(encode({key: fingerprint(data, mode)
                                          for key, (data, mode) in files.items()})).hexdigest()
        if args.command == "plan":
            print("\n".join(files))
            print("安装前请用 list/view 保存现有 hook 定义，核对新增 ID 和目标侧聊，禁用旧 hook，停止旧收发进程并等待工人收尾。")
            return
    local_path(TOOLS / ".install-history/manifest.json")
    HISTORY.mkdir(mode=0o700, exist_ok=True, parents=True)
    if HISTORY.is_symlink() or HISTORY.stat().st_uid != os.geteuid() or HISTORY.stat().st_mode & 0o077:
        fail("安装历史目录必须属于 Hatch 账号且仅本人可访问")
    with (HISTORY / ".install.lock").open("a+b") as guard, ExitStack() as locks:
        try:
            fcntl.flock(guard, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            fail("另一个安装或回退正在进行")
        history = [entry for entry in transactions() if entry[1]["state"] != "rolled_back"]
        latest = history[-1] if history else None
        if args.command == "rollback":
            if not latest or latest[0].name != args.transaction:
                fail("只能回退最近一次尚未回退的安装")
            locks.enter_context(install_locks())
            rollback(*latest)
            return
        cutover_ready = all((HOME / "workspace" / (channel + "-bridge") / "delivery/.cutover").is_file()
                            for channel in CHANNELS)
        if latest and latest[1]["state"] == "installed" and latest[1]["bundle"] == identity and cutover_ready and all(
            file_state(local_path(path)) == fingerprint(data, mode) for path, (data, mode) in files.items()
        ):
            print(f"这份文件包已经安装，事务 {latest[0].name}。")
            return
        locks.enter_context(install_locks())
        if latest and latest[1]["state"] != "installed":
            run, record = latest
            if record["state"] != "installing" or record["bundle"] != identity:
                fail(f"已有未结束的安装。请用原命令继续，或 rollback {run.name}")
        else:
            run, record = prepare(files, previous, identity)
        verify(record["files"])
        print(f"安装事务 {run.name}，清单和备份在 {run}", flush=True)
        for item in record["files"]:
            path = local_path(item["path"])
            current = file_state(path)
            if current == item["after"]:
                continue
            if current != item["before"]:
                fail(f"安装时文件发生变化：{path}")
            path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            atomic_file(path, *files[item["path"]])
        for path, (data, mode) in files.items():
            if file_state(local_path(path)) != fingerprint(data, mode):
                fail(f"安装文件与当前版本不一致：{path}")
        subprocess.run([sys.executable, str(HOME / TOOLS / "bridge_delivery.py"), "init",
                        *(str(HOME / "workspace" / (channel + "-bridge")) for channel in CHANNELS)], check=True)
        record["state"] = "installed"
        write_manifest(run, record)
        print(f"六份配置已就绪：{HOME / TOOLS / 'hatch-hooks'}。在 Hatch 对已有工位 update、新工位 add，核对六个 side_chat 后逐一 enable。")
        print(f"回退：先禁用六个 hook，停新收发进程并核对未确认的投递，然后运行本脚本 rollback {run.name}；在 Hatch 恢复原定义。")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        sys.exit(str(error))
