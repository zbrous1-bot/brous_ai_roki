/**
 * Horror Roki - Removal Helper for Watched Items in Discover
 *
 * This is a small, reusable piece of logic you can adapt into your Horror Roki frontend.
 *
 * Goal: When a user marks a title as "watched" (adds to Your Library),
 * remove it from the currently displayed "Recommended for you" / discover results
 * so it doesn't duplicate.
 *
 * You will need to adapt the variable names to match your Horror Roki code.
 * The key ideas are:
 *   - Keep a fast lookup of watched IDs (Set is best).
 *   - Have access to the current list of items being shown in recommendations (an array).
 *   - Have a way to re-draw the recommendation section.
 *   - Call the removal function right after adding something to the watched library.
 */

// Example: Call this right after the user marks a title as watched.
// 'currentRecommendationItems' should be the array your code uses for the current "Recommended for you" list.
// 'renderRecommendations' should be your function that takes a list and draws the cards.

function removeFromCurrentDiscover(id, mediaType = 'movie') {
  // 1. Remove from any in-memory pool if you have one
  if (window.currentRecommendationPool && Array.isArray(window.currentRecommendationPool)) {
    window.currentRecommendationPool = window.currentRecommendationPool.filter(item => {
      const itemKey = `${item.id}:${item.mediaType || 'movie'}`;
      const targetKey = `${id}:${mediaType}`;
      return itemKey !== targetKey;
    });
  }

  // 2. Remove from the "last rendered" list (if your code keeps one like lastRenderedItems)
  if (window.lastRenderedItems && Array.isArray(window.lastRenderedItems)) {
    window.lastRenderedItems = window.lastRenderedItems.filter(item => {
      const itemKey = `${item.id}:${item.mediaType || 'movie'}`;
      const targetKey = `${id}:${mediaType}`;
      return itemKey !== targetKey;
    });
  }

  // 3. Re-render the recommendation section with the cleaned list
  // Replace 'renderRecommendations' with whatever function you use to draw the "Recommended for you" cards.
  if (typeof window.renderRecommendations === 'function' && window.currentRecommendationPool) {
    window.renderRecommendations(window.currentRecommendationPool);
  } else if (typeof window.renderResults === 'function' && window.lastRenderedItems) {
    // Fallback if you're using the Brous-style renderResults
    window.renderResults(window.lastRenderedItems);
  } else {
    // Last resort: force a full Recompute if you have that function exposed
    if (typeof window.recomputeRecommendations === 'function') {
      window.recomputeRecommendations();
    }
  }
}

// How to wire it up in your "mark as watched" / "add to library" code:
// Example (adapt to your actual function):
//
// function markAsWatched(item) {
//   // ... your existing code to add to the watched library ...
//   addToWatchedLibrary(item);
//
//   // Immediately remove it from whatever is currently shown in Discover
//   removeFromCurrentDiscover(item.id, item.mediaType || 'movie');
//
//   // Update the "Watched" count UI if you have one
//   updateWatchedCount();
// }

// Bonus: When you do "Recompute" or build the recommendation pool,
// always filter the pool against the current watched list first.

function filterPoolAgainstWatched(pool) {
  if (!pool || !Array.isArray(pool)) return [];
  // Assuming you have a way to get the current watched IDs (array or Set)
  const watchedSet = window.watchedIds || new Set(); // or however you track watched IDs
  return pool.filter(item => {
    const key = `${item.id}:${item.mediaType || 'movie'}`;
    return !watchedSet.has(key);
  });
}

// Example usage inside your Recompute logic:
// const rawPool = ... build pool from TMDB ...
// const cleanPool = filterPoolAgainstWatched(rawPool);
// then use cleanPool for recommendations

console.log('Horror Roki removal helper loaded. Wire removeFromCurrentDiscover into your "mark as watched" flow.');