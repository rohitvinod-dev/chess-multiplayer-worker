/**
 * Script to check user data in Firestore
 * Usage: node check-user-data.js <userId>
 */

const https = require('https');
const fs = require('fs');

const FIREBASE_PROJECT_ID = 'openings-trainer';
const userId = process.argv[2] || 'nXhMPuN09KeO6bIIGcrRJJUl6Nh2';

// Read service account from wrangler secret (you'll need to provide this)
console.log('Checking data for user:', userId);
console.log('Project:', FIREBASE_PROJECT_ID);
console.log('');

// Collections to check
const collections = [
  `users/${userId}`,
  `users/${userId}/progress_openings`,
  `users/${userId}/profile`,
  `users/${userId}/matchHistory`,
  `users/${userId}/achievements`,
  `users/${userId}/custom_openings`,
  `leaderboards/elo/players/${userId}`,
  `leaderboards/tactical/players/${userId}`,
];

async function queryFirestore(path) {
  return new Promise((resolve, reject) => {
    const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/${path}`;

    https.get(url, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve(JSON.parse(data));
        } else {
          resolve(null);
        }
      });
    }).on('error', (err) => {
      reject(err);
    });
  });
}

async function checkUserData() {
  console.log('Checking Firestore collections...\n');

  for (const path of collections) {
    try {
      const data = await queryFirestore(path);

      if (data) {
        if (data.documents) {
          console.log(`✅ ${path}: ${data.documents.length} documents found`);
          if (path.includes('progress_openings') && data.documents.length > 0) {
            console.log('   First few progress documents:');
            data.documents.slice(0, 3).forEach(doc => {
              const docName = doc.name.split('/').pop();
              console.log(`   - ${docName}`);
            });
          }
        } else if (data.fields) {
          console.log(`✅ ${path}: Document exists`);
          // Show some key fields
          const fields = Object.keys(data.fields);
          if (fields.length > 0) {
            console.log(`   Fields: ${fields.slice(0, 5).join(', ')}${fields.length > 5 ? '...' : ''}`);
          }
        } else {
          console.log(`⚠️  ${path}: Unexpected format`);
        }
      } else {
        console.log(`❌ ${path}: Not found or empty`);
      }
    } catch (error) {
      console.log(`❌ ${path}: Error - ${error.message}`);
    }
  }

  console.log('\n=== Summary ===');
  console.log('If progress_openings shows 0 documents or not found, the data is lost.');
  console.log('If progress_openings has documents, the issue is with the app/Worker connection.');
}

checkUserData().catch(console.error);
