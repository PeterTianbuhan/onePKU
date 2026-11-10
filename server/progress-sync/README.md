# 观看进度同步

一台只给 Peter 自己用的边车：安卓和桌面把同一节课的播放位置、是否看完，按原始 `course_id` + `episode_id` 写到这里。最后写入的位置赢；一旦看完就保持看完。学校的好学观看记录不走这里。

进程只听 `127.0.0.1`。对外只经过这台机器上已有的 Caddy，再由 Tailscale Funnel 暴露。令牌不进仓库。

## 生成令牌

至少 24 个非空白字符。用 32 字节十六进制：

```sh
openssl rand -hex 32
```

写到服务器上的 `/etc/onepku-progress.env`，权限 `0600`，不要提交：

```sh
ONEPKU_PROGRESS_TOKEN=<上面那行的输出>
ONEPKU_PROGRESS_DIR=/var/lib/onepku-progress
ONEPKU_PROGRESS_PORT=8787
```

## 安装

数据目录默认 `/var/lib/onepku-progress/`（SQLite 文件 `progress.sqlite`）。

```sh
sudo useradd --system --home /var/lib/onepku-progress --shell /usr/sbin/nologin onepku || true
sudo mkdir -p /var/lib/onepku-progress /opt/onepku/progress-sync
sudo cp progress_sync.py /opt/onepku/progress-sync/progress_sync.py
sudo chown -R onepku:onepku /var/lib/onepku-progress
sudo cp onepku-progress.service /etc/systemd/system/onepku-progress.service
sudo systemctl daemon-reload
sudo systemctl enable --now onepku-progress
curl -fsS http://127.0.0.1:8787/healthz
```

`healthz` 不需要令牌。`/v1/progress` 只接受 `Authorization: Bearer`，查询串里的 `token`、`access_token`、`authorization` 直接 400，即使头里的令牌是对的。

## Caddy

加在现有站点里。`handle_path` 会剥掉前缀，边车自己的路径仍然是 `/healthz` 和 `/v1/progress`。

```caddy
handle_path /onepku-progress/* {
	reverse_proxy 127.0.0.1:8787
}
```

客户端用的基地址：

```text
https://vm-0-7-ubuntu.taild19091.ts.net/onepku-progress
```

## 客户端怎么配

桌面：可选文件 `~/.config/onepku/progress-sync.json`（不要提交）。没有这个文件，或者令牌短于 24 字符，同步保持关闭，播放不受影响。

```json
{
  "url": "https://vm-0-7-ubuntu.taild19091.ts.net/onepku-progress",
  "token": "<openssl rand -hex 32 的输出>"
}
```

设备号写在同目录的 `progress-device-id`，第一次同步时生成。

安卓：调试包可以在 `android/local.properties`（已忽略）里写 `onepku.progress.url` 和 `onepku.progress.token`。公开构建和 CI 不带令牌，同步关闭。装好之后也可以在「设置」里填写，覆盖构建配置；令牌放在本机加密存储里。

打开播放器时拉取，进度变化后大约 20 秒推一次，暂停、结束、离开时立刻推。网络失败只放弃这一次同步。
