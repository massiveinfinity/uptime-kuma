let express = require("express");
const { R } = require("redbean-node");

const { UptimeKumaServer } = require("../uptime-kuma-server");
const { login } = require("../auth");
const { log } = require("../../src/util");
const apicache = require("../modules/apicache");

const server = UptimeKumaServer.getInstance();
let router = express.Router();

/**
 * Check if a given user owns a specific monitor
 * @param {number} userID ID of user to check
 * @param {number} monitorID ID of monitor to check
 * @returns {Promise<void>}
 * @throws {Error} The specified user does not own the monitor
 */
async function checkOwner(userID, monitorID) {
    let row = await R.getRow(
        "SELECT id FROM monitor WHERE id = ? AND user_id = ? ",
        [monitorID, userID]
    );

    if (!row) {
        throw new Error("You do not own this monitor.");
    }
}

/**
 * Start the specified monitor
 * @param {number} userID ID of user who owns monitor
 * @param {number} monitorID ID of monitor to start
 * @param {Array} monitorNewTags Any new tags created for the monitor
 * @returns {Promise<void>}
 */
async function startMonitor(userID, monitorID, monitorNewTags) {
    await checkOwner(userID, monitorID);

    log.info("manage", `Resume Monitor: ${monitorID} User ID: ${userID}`);

    await R.exec(
        "UPDATE monitor SET active = 1 WHERE id = ? AND user_id = ? ",
        [monitorID, userID]
    );

    let monitor = await R.findOne("monitor", " id = ? ", [monitorID]);

    if (monitor.id in server.monitorList) {
        server.monitorList[monitor.id].stop();
    }

    server.monitorList[monitor.id] = monitor;
    await monitor.start(server.io, monitorNewTags);
}

/**
 * Restart a given monitor
 * @param {number} userID ID of user who owns monitor
 * @param {number} monitorID ID of monitor to start
 * @returns {Promise<void>}
 */
async function restartMonitor(userID, monitorID) {
    return await startMonitor(userID, monitorID);
}

router.get("/massive/api/monitors", async (req, res) => {
    try {
        const { authorization } = req.headers;
        const [username, password] = Buffer.from(
            authorization.replace("Basic ", ""),
            "base64"
        )
            .toString()
            .split(":");
        const user = await login(username, password);
        const { id: userId } = user;

        const monitors = [];

        const monitorList = await R.find(
            "monitor",
            " user_id = ? ORDER BY weight DESC, name",
            [userId]
        );

        for (const monitor of monitorList) {
            monitors.push(await monitor.toJSON());
        }

        res.json({
            ok: true,
            result: monitors,
        });
    } catch (e) {
        res.status(404).json({
            ok: false,
            msg: e.message,
        });
    }
});

router.post("/massive/api/monitor", async (req, res) => {
    try {
        const { authorization } = req.headers;
        const [username, password] = Buffer.from(
            authorization.replace("Basic ", ""),
            "base64"
        )
            .toString()
            .split(":");
        const user = await login(username, password);
        const { id: userId } = user;

        const newMonitor = req.body;
        const newTags = [];
        if (newMonitor.new_tags) {
            newTags.push(...newMonitor.new_tags);
            delete newMonitor.new_tags;
        }

        newMonitor.accepted_statuscodes_json = JSON.stringify(
            newMonitor.accepted_statuscodes
        );
        delete newMonitor.accepted_statuscodes;

        const bean = R.dispense("monitor");
        bean.import(newMonitor);
        bean.user_id = userId;

        bean.validate();

        await R.store(bean);

        await server.sendMonitorList({ userID: userId });

        if (newMonitor.active !== false) {
            await startMonitor(userId, bean.id, newTags);
        }

        log.info("monitor", `Added Monitor: ${bean.id} User ID: ${userId}`);

        if (newTags.length > 0) {
            for (const newTag of newTags) {
                let tag = await R.findOne("tag", " name = ?", [newTag.name]);
                if (!tag) {
                    log.warn(
                        `No tag found in database of name: ${newTag.name}`
                    );

                    // Create new tag if not found
                    tag = R.dispense("tag");
                    tag.name = newTag.name;
                    tag.color = "#4B5563";

                    tag.id = await R.store(tag);
                }

                await R.exec(
                    "INSERT INTO monitor_tag (tag_id, monitor_id, value) VALUES (?,?,?)",
                    [tag.id, bean.id, newTag.value]
                );
            }
        }

        res.json({
            ok: true,
            result: {
                monitorId: bean.id,
            },
        });
    } catch (e) {
        res.status(500).json({
            ok: false,
            msg: e.message,
        });
    }
});

router.put("/massive/api/monitor/:monitorId", async (req, res) => {
    try {
        const { authorization } = req.headers;
        const [username, password] = Buffer.from(
            authorization.replace("Basic ", ""),
            "base64"
        )
            .toString()
            .split(":");
        const user = await login(username, password);
        const { id: userId } = user;

        const {
            params: { monitorId },
        } = req;

        const editMonitor = req.body;

        let bean = await R.findOne("monitor", " id = ? ", [monitorId]);

        if (bean.user_id !== userId) {
            throw new Error("Permission denied.");
        }

        if (editMonitor.name) {
            bean.name = editMonitor.name;
        }

        if (editMonitor.url) {
            bean.url = editMonitor.url;
        }

        bean.validate();

        await R.store(bean);

        if (await bean.isActive()) {
            await restartMonitor(userId, bean.id);
        }

        await server.sendMonitorList({ userID: userId });

        res.json({
            ok: true,
            result: bean.id,
        });
    } catch (e) {
        res.status(500).json({
            ok: false,
            msg: e.message,
        });
    }
});

router.delete("/massive/api/monitor/:monitorId", async (req, res) => {
    try {
        const { authorization } = req.headers;
        const [username, password] = Buffer.from(
            authorization.replace("Basic ", ""),
            "base64"
        )
            .toString()
            .split(":");
        const user = await login(username, password);
        const { id: userId } = user;

        const {
            params: { monitorId },
        } = req;

        log.info("manage", `Delete Monitor: ${monitorId} User ID: ${userId}`);

        if (monitorId in server.monitorList) {
            server.monitorList[monitorId].stop();
            delete server.monitorList[monitorId];
        }

        const startTime = Date.now();

        await R.exec("DELETE FROM monitor WHERE id = ? AND user_id = ? ", [
            monitorId,
            userId,
        ]);

        // Remove the tag also
        await R.exec("DELETE FROM monitor_tag WHERE id = ?", [monitorId]);

        // Fix #2880
        apicache.clear();

        const endTime = Date.now();

        log.info(
            "DB",
            `Delete Monitor completed in : ${endTime - startTime} ms`
        );

        res.json({
            ok: true,
        });
    } catch (e) {
        res.status(500).json({
            ok: false,
            msg: e.message,
        });
    }
});

module.exports = router;
