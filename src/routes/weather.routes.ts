/** /api/v1/weather — OpenWeatherMap proxy */

import { Router, Request, Response, NextFunction } from "express";
import { authMiddleware } from "../middleware/auth";
import { BadRequestError } from "../utils/errors";
import {
  getCurrentWeather,
  getForecast,
  getWeatherForLocation,
} from "../services/weather/weather.service";

const router = Router();
router.use(authMiddleware as never);

router.get("/current", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const lat = parseFloat(String(req.query.lat ?? ""));
    const lon = parseFloat(String(req.query.lon ?? ""));
    if (isNaN(lat) || isNaN(lon)) throw new BadRequestError("lat and lon are required.");
    res.json(await getCurrentWeather(lat, lon));
  } catch (err) {
    next(err);
  }
});

router.get("/forecast", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const lat = parseFloat(String(req.query.lat ?? ""));
    const lon = parseFloat(String(req.query.lon ?? ""));
    const hours = parseInt(String(req.query.hours ?? "24"), 10);
    if (isNaN(lat) || isNaN(lon)) throw new BadRequestError("lat and lon are required.");
    res.json({ forecast: await getForecast(lat, lon, hours) });
  } catch (err) {
    next(err);
  }
});

router.get("/for-location", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const lat = parseFloat(String(req.query.lat ?? ""));
    const lon = parseFloat(String(req.query.lon ?? ""));
    if (isNaN(lat) || isNaN(lon)) throw new BadRequestError("lat and lon are required.");
    res.json(await getWeatherForLocation(lat, lon));
  } catch (err) {
    next(err);
  }
});

export default router;
