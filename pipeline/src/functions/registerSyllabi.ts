import * as functions from 'firebase-functions';
import { findCourse, saveCourse } from '../repositories/courseRepo';
import { publishSyllabus } from '../repositories/syllabusRepo';

/**
 * Background Cloud Function to be triggered by Cloud Storage. When a file is added to
 * the inbox bucket, if it is a syllabus, we will try to match it to associated course(s).
 * Successful syllabi are moved to the "syllabi/" bucket and made public, while non-matching
 * syllabi are left in the inbox for manual review.
 */
export const registerSyllabi = functions.storage.object().onFinalize(async (object) => {
  const { bucket, name, contentType } = object;

  if (!name || !contentType) {
    return;
  }

  // Filter out anything that's not a PDF
  if (!contentType.startsWith('application/pdf')) {
    console.log('Skipping file (not a PDF)', name);
    return;
  }

  // Filter out anything that's not in the inbox folder
  const [folder, fileName] = name.split('/');

  if (folder !== 'inbox') {
    console.log('Skipping file (not in "inbox/" folder)', name);
    return;
  }

  // Validate file name format: https://regex101.com/r/zQIuFK/3
  const syllabusPattern = /^([^\W_]+)_([A-Za-z]+)([0-9-]+)_([A-Za-z0-9-]+)(?:_([A-Z]+)(\d{2})(\d{2}))?\.pdf$/i;
  const [match, courseName, season, year, professor, days, hour, minute] =
    syllabusPattern.exec(fileName) || [];

  if (!match) {
    console.error(`${fileName} does not match the syllabus pattern.`);
    return;
  }

  // Grab the course document from the database
  const course = await findCourse(courseName);

  if (!course) {
    console.error(`Course ${courseName} does not exist yet.`);
    return;
  }

  // Validate matching sections exist
  const sectionKey = {
    term: `${season} ${year}`,
    last_name: professor,
    ...(days && { days, time: `${hour}:${minute}:00` }),
  };

  if (!course.hasSection(sectionKey)) {
    console.error(`Course ${courseName} has no matching sections.`);
    return;
  }

  // Assign the syllabus to any matching sections
  try {
    const updatedCourse = course.addSyllabus(sectionKey, `syllabi/${fileName}`);

    // Save changes
    await publishSyllabus(bucket, name);
    await saveCourse(updatedCourse);

    const updateCount =
      updatedCourse.sections.map((section) => section.syllabus).length -
      course.sections.filter((section) => section.syllabus).length;

    console.log(`Updated ${updateCount} sections.`);
  } catch (err) {
    console.error(`Unable to assign syllabus to section(s). Is there already a syllabus?`);
  }
});
