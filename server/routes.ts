import type { Express, Request, Response } from "express";
import { createServer, type Server } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import * as fs from "fs";
import * as path from "path";

interface Client {
  id: string;
  role: "camera" | "monitor";
  name?: string;
  ws: WebSocket;
}

export async function registerRoutes(app: Express): Promise<Server> {
  const cameraTemplatePath = path.resolve(process.cwd(), "server", "templates", "camera.html");
  const monitorTemplatePath = path.resolve(process.cwd(), "server", "templates", "monitor.html");

  app.get("/camera", (_req: Request, res: Response) => {
    const html = fs.readFileSync(cameraTemplatePath, "utf-8");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.status(200).send(html);
  });

  app.get("/monitor", (_req: Request, res: Response) => {
    const html = fs.readFileSync(monitorTemplatePath, "utf-8");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.status(200).send(html);
  });

  const httpServer = createServer(app);

  const wss = new WebSocketServer({ noServer: true });
  const clients = new Map<string, Client>();

  function generateId(): string {
    return Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
  }

  function getMonitors(): Client[] {
    return Array.from(clients.values()).filter(c => c.role === "monitor");
  }

  function getCameras(): Client[] {
    return Array.from(clients.values()).filter(c => c.role === "camera");
  }

  wss.on("connection", (ws: WebSocket) => {
    let clientId: string | null = null;

    ws.on("message", (data: Buffer | string) => {
      try {
        const msg = JSON.parse(data.toString());

        switch (msg.type) {
          case "register": {
            clientId = generateId();
            const client: Client = {
              id: clientId,
              role: msg.role,
              name: msg.name || "Unknown",
              ws,
            };
            clients.set(clientId, client);

            ws.send(JSON.stringify({ type: "registered", id: clientId }));
            console.log(`[REGISTER] ${msg.role} (${clientId}) name=${msg.name || "N/A"}`);

            if (msg.role === "monitor") {
              const cameras = getCameras();
              console.log(`[SIGNAL] Monitor ${clientId} registered, requesting offers from ${cameras.length} cameras`);
              cameras.forEach(cam => {
                cam.ws.send(JSON.stringify({
                  type: "request-offer",
                  monitorId: clientId,
                }));
                console.log(`[SIGNAL] Sent request-offer to camera ${cam.id} for monitor ${clientId}`);
              });
            }

            if (msg.role === "camera") {
              const monitors = getMonitors();
              console.log(`[SIGNAL] Camera ${clientId} registered, sending request-offer for ${monitors.length} monitors`);
              monitors.forEach(monitor => {
                ws.send(JSON.stringify({
                  type: "request-offer",
                  monitorId: monitor.id,
                }));
                console.log(`[SIGNAL] Sent request-offer to camera ${clientId} for monitor ${monitor.id}`);
              });
            }
            break;
          }

          case "offer": {
            const target = clients.get(msg.targetId);
            console.log(`[SIGNAL] Offer from ${msg.fromId} to ${msg.targetId} (target found: ${!!target})`);
            if (target) {
              target.ws.send(JSON.stringify({
                type: "offer",
                offer: msg.offer,
                fromId: msg.fromId,
                cameraName: msg.cameraName,
              }));
            }
            break;
          }

          case "answer": {
            const target = clients.get(msg.targetId);
            console.log(`[SIGNAL] Answer from ${msg.fromId} to ${msg.targetId} (target found: ${!!target})`);
            if (target) {
              target.ws.send(JSON.stringify({
                type: "answer",
                answer: msg.answer,
                fromId: msg.fromId,
              }));
            }
            break;
          }

          case "ice-candidate": {
            const target = clients.get(msg.targetId);
            if (target) {
              target.ws.send(JSON.stringify({
                type: "ice-candidate",
                candidate: msg.candidate,
                fromId: msg.fromId,
              }));
            }
            break;
          }
        }
      } catch (err) {
        console.error("WebSocket message error:", err);
      }
    });

    ws.on("close", () => {
      if (clientId) {
        const client = clients.get(clientId);
        if (client) {
          console.log(`[DISCONNECT] ${client.role} (${clientId})`);

          if (client.role === "camera") {
            getMonitors().forEach(monitor => {
              monitor.ws.send(JSON.stringify({
                type: "camera-disconnected",
                cameraId: clientId,
              }));
            });
          }

          if (client.role === "monitor") {
            getCameras().forEach(cam => {
              cam.ws.send(JSON.stringify({
                type: "monitor-disconnected",
                monitorId: clientId,
              }));
            });
          }

          clients.delete(clientId);
        }
      }
    });
  });

  httpServer.on("upgrade", (request, socket, head) => {
    if (request.url === "/ws") {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit("connection", ws, request);
      });
    } else {
      socket.destroy();
    }
  });

  return httpServer;
}
