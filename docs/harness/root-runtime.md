# Device root runtime

The source-deployment systemd template `scripts/hermes-web-ui.service` runs the
Web UI as `User=root` and `Group=root`. Terminals, Agents, plugins and other
children inherit that identity. Web authentication still controls access to
the application; a signed-in operator who can execute commands has root access
to the device.

`APP_USER` remains the provisioning/data account (normally `hermesui`). Keep
`HOME`, `HERMES_WEB_UI_HOME`, `HERMES_WEBUI_STATE_DIR` (when configured),
`HERMES_HOME` and tool paths pointing at the existing installation. Changing
the effective UID must not create a fresh profile under `/root`, move user
data, or install a second Hermes runtime. Studio-managed npm CLIs stay under
the configured Web UI home, independently of the service UID and Node runtime.

For an existing device, install this override without rerunning bootstrap:

```ini
# /etc/systemd/system/hermes-web-ui.service.d/95-root-runtime.conf
[Service]
User=root
Group=root
```

Run `systemd-analyze verify hermes-web-ui.service`, then
`systemctl daemon-reload` and `systemctl restart hermes-web-ui`. Verify the
effective UID of the main process and Hermes bridge, the health endpoint,
and Agent inventory after restart. Do not change the environment's HOME or
state directories. The override persists outside the atomic release tree
and survives service restarts and source-deploy updates. Fresh bootstrap uses
the same identity from the service template; upgrades must continue to use
the update orchestrator rather than the bootstrap script.

To return an existing device to an unprivileged runtime, explicitly override
both User and Group with its provisioning account and repair ownership only
for the state/tool paths that need it. Root may have created files there;
do not recursively chown USB mounts or unrelated system directories.
