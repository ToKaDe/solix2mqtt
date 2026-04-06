import { LoginResultResponse, SolixApi } from "./api";
import { anonymizeConfig, getConfig } from "./config";
import { consoleLogger } from "./logger";
import { sleep } from "./utils";
import { Publisher } from "./publish";
import { FilePersistence, Persistence } from "./persistence";

const config = getConfig();
const logger = consoleLogger(config.verbose);

function isLoginValid(loginData: LoginResultResponse, now: Date = new Date()) {
  return new Date(loginData.token_expires_at * 1000).getTime() > now.getTime();
}

// Track last forecast poll per site to avoid polling more than once per hour
const lastForecastPoll: Record<string, Date> = {};

function shouldPollForecast(siteId: string, now: Date = new Date()): boolean {
  const last = lastForecastPoll[siteId];
  if (!last) return true;
  return last.getFullYear() !== now.getFullYear()
    || last.getMonth() !== now.getMonth()
    || last.getDate() !== now.getDate()
    || last.getHours() !== now.getHours();
}

async function run(): Promise<void> {
  logger.log(JSON.stringify(anonymizeConfig(config)));
  const api = new SolixApi({
    username: config.username,
    password: config.password,
    country: config.country,
    logger,
  });

  const persistence: Persistence<LoginResultResponse> = new FilePersistence(config.loginStore);

  const publisher = new Publisher(config.mqttUrl, config.mqttRetain, config.mqttClientId.length > 0 ? config.mqttClientId : undefined, config.mqttUsername, config.mqttPassword);
  async function fetchAndPublish(): Promise<void> {
    logger.log("Fetching data");
    let loginData = await persistence.retrieve();
    if (loginData == null || !isLoginValid(loginData)) {
      const loginResponse = await api.login();
      loginData = loginResponse.data ?? null;
      if (loginData) {
        await persistence.store(loginData);
      } else {
        logger.error(`Could not log in: ${loginResponse.msg} (${loginResponse.code})`);
      }
    } else {
      logger.log("Using cached auth data");
    }
    if (loginData) {
      const loggedInApi = api.withLogin(loginData);
      const siteHomepage = await loggedInApi.siteHomepage();
      let topic = `${config.mqttTopic}/site_homepage`;
      await publisher.publish(topic, siteHomepage.data);

      let sites;
      if (siteHomepage.data.site_list.length === 0) {
        // Fallback for Shared Accounts
        sites = (await loggedInApi.getSiteList()).data.site_list;
      } else {
        sites = siteHomepage.data.site_list;
      }
      for (const site of sites) {
        const scenInfo = await loggedInApi.scenInfo(site.site_id);
        topic = `${config.mqttTopic}/site/${site.site_name}/scenInfo`;
        await publisher.publish(topic, scenInfo.data);

        // Fetch PV forecast – only works when AI/Smart Mode is active on the Solix 3.
        // Poll at most once per hour to avoid unnecessary API load.
        // Note: device_sn must be empty string to get site-level forecast data.
        const now = new Date();
        if (shouldPollForecast(site.site_id, now)) {
          try {
            logger.log(`Fetching PV forecast for site ${site.site_name}`);
            const today = new Date();
            const tomorrow = new Date(today);
            tomorrow.setDate(today.getDate() + 1);

            // Today: actual production so far + forecast rest of day
            const forecastToday = await loggedInApi.energyAnalysis({
              siteId: site.site_id,
              deviceSn: "",
              type: "day",
              deviceType: "solar_production",
              startTime: today,
            });
            // Tomorrow: full 24h forecast (required when current hour > 0)
            const forecastTomorrow = await loggedInApi.energyAnalysis({
              siteId: site.site_id,
              deviceSn: "",
              type: "day",
              deviceType: "solar_production",
              startTime: tomorrow,
            });

            const todayData = forecastToday.data;
            const tomorrowData = forecastTomorrow.data;

            // Combine forecast trend from today and tomorrow
            const combinedTrend = [
              ...(todayData?.forecast_trend ?? []),
              ...(tomorrowData?.forecast_trend ?? []),
            ];

            if (todayData?.solar_total !== undefined) {
              lastForecastPoll[site.site_id] = now;
              topic = `${config.mqttTopic}/site/${site.site_name}/forecast`;
              await publisher.publish(topic, {
                forecast_total: todayData.forecast_total ?? "",
                forecast_total_tomorrow: tomorrowData?.forecast_total ?? "",
                forecast_trend: combinedTrend,
                solar_total: todayData.solar_total ?? "",
                trend_unit: todayData.trend_unit ?? "",
                local_time: todayData.local_time ?? "",
              });
              logger.log(`PV forecast published for site ${site.site_name}`);
            } else {
              logger.log(`No PV forecast data available for site ${site.site_name} – AI/Smart Mode may not be active`);
            }
          } catch (e) {
            logger.warn(`Failed to fetch PV forecast for site ${site.site_name}`, e);
          }
        } else {
          logger.log(`Skipping PV forecast for site ${site.site_name} – already polled this hour`);
        }
      }
      logger.log("Published.");
    } else {
      logger.error("Not logged in");
    }
  }

  for (;;) {
    const start = new Date().getTime();
    try {
      await fetchAndPublish();
    } catch (e) {
      logger.warn("Failed fetching or publishing printer data", e);
    }
    const end = new Date().getTime() - start;
    const sleepInterval = config.pollInterval * 1000 - end;
    logger.log(`Sleeping for ${sleepInterval}ms...`);
    await sleep(sleepInterval);
  }
}

run()
  .then(() => {
    logger.log("Done");
  })
  .catch((err) => {
    logger.error(err);
    process.exit(1);
  });
