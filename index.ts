import puppeteer from 'puppeteer';

const REPEAT_COUNT = 50;
const DELAY_BETWEEN_REQUESTS = 10; // ms

// Check for --test flag in command line arguments
const TEST_MODE = process.argv.includes('--test');

async function parseLessons(page: any) {
  return await page.evaluate(() => {
    const rows = document.querySelectorAll('table.tbl_col tbody tr');
    const lessons: Array<{
      title: string;
      progress: string;
      completed: boolean;
      contentId: string | null;
      batchId: string | null;
    }> = [];

    rows.forEach((row: Element) => {
      // Skip group header rows
      if (row.querySelector('th.group')) return;

      const titleDiv = row.querySelector('td.al .td');
      const progressDiv = row.querySelectorAll('td')[2]?.querySelector('.td');
      const completedDiv = row.querySelectorAll('td')[4]?.querySelector('.td');
      const studyBtn = row.querySelector('a.c_btn.sm.blue');

      if (titleDiv && studyBtn) {
        const title = titleDiv.textContent?.trim() || '';
        const progress = progressDiv?.textContent?.trim() || '0%';
        const completedText = completedDiv?.textContent?.trim() || '';
        const completed = completedText.includes('학습완료');

        // Extract onclick attribute
        const onclick = studyBtn.getAttribute('onclick') || '';
        const match = onclick.match(/REQ\.studyCntsStart\('([^']+)','([^']+)',/);

        lessons.push({
          title,
          progress,
          completed,
          contentId: match?.[1] ?? null,
          batchId: match?.[2] ?? null,
        });
      }
    });

    return lessons;
  });
}

interface Lesson {
  title: string;
  progress: string;
  completed: boolean;
  contentId: string | null;
  batchId: string | null;
  index?: number;
}

async function main() {
  const username = prompt('id: ');
  const password = prompt('pw ');
  const classroomId = 'APL00000000000503603';

  if (!username || !password || !classroomId) {
    console.error('fill in all information.');
    process.exit(1);
  }

  const browser = await puppeteer.launch({
    headless: false, // Set to true if you don't want to see the browser
    defaultViewport: null,
  });

  try {
    const page = await browser.newPage();

    // Navigate to login page
    console.log('\nNavigating to https://www.keli.kr/cmmn/login.do...');
    await page.goto('https://www.keli.kr/cmmn/login.do', {
      waitUntil: 'networkidle2',
      timeout: 30000,
    });

    // Login
    await page.type('input[name="id"]', username);
    await page.type('input[name="password"]', password);
    await page.click('a.enter');

    await page.waitForNavigation({
      waitUntil: 'networkidle2',
      timeout: 30000,
    });
    console.log('Login successful!');

    // Navigate to classroom page
    console.log(`Navigating to classroom page: ${classroomId}`);
    await page.goto(`https://www.keli.kr/user/study/classroom/main.do?crsAplcntId=${classroomId}`, {
      waitUntil: 'networkidle2',
      timeout: 30000,
    });

    // Get JSESSIONID cookie using browser context
    const context = browser.defaultBrowserContext();
    const cookies = await context.cookies();
    const jsessionid = cookies.find((c) => c.name === 'JSESSIONID')?.value;

    let processedCount = 0;

    while (true) {
      // Parse lesson table
      console.log('\n📋 Parsing lesson table...');
      const lessonData = await parseLessons(page);

      console.log(`\nFound ${lessonData.length} lessons:`);

      let completedCount = 0;
      let nextLesson = null as Lesson | null;

      lessonData.forEach((lesson: any, index: number) => {
        const status = lesson.completed ? '✓' : '✗';
        console.log(`${status} ${index + 1}. ${lesson.title} (${lesson.progress})`);

        if (lesson.completed) {
          completedCount++;
        } else if (!nextLesson) {
          nextLesson = { ...lesson, index: index + 1 } as Lesson;
        }
      });

      console.log(`\nCompleted: ${completedCount}/${lessonData.length} lessons`);

      // Determine which lesson to process
      if (TEST_MODE && processedCount >= 1) {
        console.log('\n[TEST MODE] Completed 1 lesson, stopping');
        break;
      }

      // In TEST_MODE, always use first lesson even if all completed
      if (TEST_MODE && !nextLesson) {
        console.log('\n[TEST MODE] All lessons completed, forcing first lesson');
        nextLesson = { ...lessonData[0], index: 1 } as Lesson;
      }

      if (!nextLesson) {
        console.log('\n✅ All lessons completed! 🎉');
        break;
      }

      if (!nextLesson.contentId || !nextLesson.batchId) {
        console.log(`\n⚠️ Next lesson missing IDs: ${nextLesson.title}`);
        break;
      }

      console.log(`\n🎯 Starting lesson: ${nextLesson.title}`);
      console.log(`Content ID: ${nextLesson.contentId}`);
      console.log(`Batch ID: ${nextLesson.batchId}`);

      // Call REQ.studyCntsStart to open lesson in popup
      console.log('Calling REQ.studyCntsStart...');

      await page.evaluate(
        (contentId: string, batchId: string) => {
          (window as any).REQ.studyCntsStart(contentId, batchId, 1300, 800);
        },
        nextLesson.contentId,
        nextLesson.batchId
      );

      // Wait for popup window to open
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Get all pages (including popup)
      const pages = await browser.pages();
      const lessonPage = pages[pages.length - 1]; // Get the last opened page (popup)

      if (!lessonPage) {
        console.log('❌ Failed to find lesson popup window');
        continue;
      }

      console.log(`Popup opened, getting request body...`);

      // Wait for API to be available and capture request body
      await lessonPage.waitForFunction(() => typeof (window as any).API !== 'undefined', { timeout: 30000 });
      console.log('✅ API loaded');

      // Build request body from API data
      const requestBody = await lessonPage.evaluate(() => {
        const api = (window as any).API;
        const params = new URLSearchParams();

        // Get all required parameters from API
        params.append('cntsId', api.learningData.cntsId || '');
        params.append('refSylbId', api.learningData.refSylbId || '');
        params.append('studyTime', '99999999');
        params.append('cmi.completion_status', 'complete');
        params.append('cmi.progress_measure', '1.0');
        params.append('save_progress_measure', '1.0');
        params.append('content_progress_measure', '1.0');
        params.append('cmi.success_status', 'passed');
        params.append('cmi.score_scaled', '100');

        return params.toString();
      });

      console.log('📝 Request body:', requestBody);
      console.log('🍪 JSESSIONID:', jsessionid);
      console.log('Request body prepared, starting automation...');

      // Execute fetch-based automation
      await lessonPage.evaluate(
        (repeatCount: number, requestBody: string, delayMs: number) => {
          return new Promise<void>(async (resolve) => {
            console.log(`🚀 Starting automation (${repeatCount} requests)...`);

            let successCount = 0;

            for (let i = 0; i < repeatCount; i++) {
              try {
                console.log(`[${i + 1}/${repeatCount}] 📤 Sending request...`);

                const response = await fetch('https://www.keli.kr/cmmn/study/cnts/commit.do', {
                  method: 'POST',
                  credentials: 'include',
                  headers: {
                    Accept: 'application/json, text/javascript, */*; q=0.01',
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'X-Requested-With': 'XMLHttpRequest',
                  },
                  body: requestBody,
                });

                const data = await response.text();
                console.log(`[${i + 1}/${repeatCount}] 📥 Response (${response.status}): ${data}`);

                if (response.ok) {
                  successCount++;
                }

                // Progress log every 10 requests
                if ((i + 1) % 10 === 0) {
                  console.log(`  ✅ Progress: ${i + 1}/${repeatCount} (Success: ${successCount})`);
                }

                // Wait between requests
                await new Promise((r) => setTimeout(r, delayMs));
              } catch (error) {
                console.error(`  ❌ Request ${i + 1} failed:`, error);
              }
            }

            console.log(`✔️ Automation complete! (Success: ${successCount}/${repeatCount})`);
            resolve();
          });
        },
        REPEAT_COUNT,
        requestBody,
        DELAY_BETWEEN_REQUESTS
      );

      console.log(`✅ Lesson "${nextLesson.title}" completed!`);

      // Close lesson page
      // await lessonPage.close();

      // Navigate back to classroom page
      console.log('\n🔄 Returning to classroom page...');

      await page.goto(`https://www.keli.kr/user/study/classroom/main.do?crsAplcntId=${classroomId}`, {
        waitUntil: 'networkidle2',
        timeout: 90000,
      });

      processedCount++;

      console.log('\n⏳ Waiting 2 seconds before checking next lesson...');
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    console.log('\n🎉 All processing complete!');
    console.log(`Processed ${processedCount} lesson(s)`);

    // await browser.close();
  } catch (error) {
    console.error('Error occurred:', error);
    await browser.close();
  }
}

main();
