import { Page } from "playwright";
import { log } from "../../utils";
import { googleMeetingEndedIndicators } from "./selectors";

/**
 * Check if the meeting has ended (host ended meeting for everyone)
 * This is different from bot removal - this is when the meeting itself ends
 */
export async function checkForGoogleMeetingEnd(page: Page): Promise<boolean> {
  try {
    // Check for meeting ended indicators
    for (const selector of googleMeetingEndedIndicators) {
      try {
        const element = await page.locator(selector).first();
        if (await element.isVisible()) {
          log(`🏁 Google Meet ended detected: Found indicator "${selector}"`);
          return true;
        }
      } catch (e) {
        // Continue checking other selectors
        continue;
      }
    }

    // Additional check: If "Leave call" button is no longer present, meeting might have ended
    // This happens when the host ends the meeting for everyone
    try {
      const leaveButton = await page.locator('button[aria-label="Leave call"]').first();
      const isLeaveButtonVisible = await leaveButton.isVisible().catch(() => false);

      // If leave button is not visible, check if we're on a different page
      if (!isLeaveButtonVisible) {
        const url = page.url();
        // If URL changed away from /meet/ or shows any of these patterns, meeting ended
        if (!url.includes('/meet/') || url.includes('finished') || url.includes('ended')) {
          log(`🏁 Google Meet ended detected: URL changed to ${url}`);
          return true;
        }
      }
    } catch (e) {
      // Ignore errors in additional check
    }

    return false;
  } catch (error: any) {
    log(`Error checking for Google Meet end: ${error.message}`);
    return false;
  }
}

/**
 * Start monitoring for meeting end from Node.js side
 * Checks every 2 seconds if the meeting has ended
 */
export function startGoogleMeetingEndMonitor(
  page: Page,
  onMeetingEnd?: () => void | Promise<void>
): () => void {
  log("Starting Google Meet end monitoring...");
  let meetingEndDetected = false;

  const meetingEndCheckInterval = setInterval(async () => {
    try {
      const hasEnded = await checkForGoogleMeetingEnd(page);
      if (hasEnded && !meetingEndDetected) {
        meetingEndDetected = true; // Prevent duplicate detection
        log("🏁 Google Meet has ended. Initiating graceful shutdown...");
        clearInterval(meetingEndCheckInterval);

        // Try to dismiss any dialogs
        try {
          await page.evaluate(() => {
            const clickIfVisible = (el: HTMLElement | null) => {
              if (!el) return;
              const rect = el.getBoundingClientRect();
              const cs = getComputedStyle(el);
              if (
                rect.width > 0 &&
                rect.height > 0 &&
                cs.display !== "none" &&
                cs.visibility !== "hidden"
              ) {
                el.click();
              }
            };
            const btns = Array.from(document.querySelectorAll("button")) as HTMLElement[];
            for (const b of btns) {
              const t = (b.textContent || b.innerText || "").trim().toLowerCase();
              const a = (b.getAttribute("aria-label") || "").toLowerCase();
              if (
                t === "return to home screen" ||
                a.includes("return to home") ||
                t === "close" ||
                t === "ok"
              ) {
                clickIfVisible(b);
                break;
              }
            }
          });
        } catch {}

        // Signal meeting end to caller
        try {
          await onMeetingEnd?.();
        } catch {}
      }
    } catch (error: any) {
      log(`Error during Google Meet end check: ${error.message}`);
    }
  }, 2000); // Check every 2 seconds

  // Return cleanup function
  return () => {
    clearInterval(meetingEndCheckInterval);
  };
}
