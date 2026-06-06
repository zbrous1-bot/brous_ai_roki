# Horror Roki - Removing Watched Movies from Discover (Layman's Guide)

## The Problem (in plain English)
Right now, when you mark a movie as "watched" (add it to Your Library), it can still sit in the "Recommended for you" list on the Discover tab.

This creates duplicates — the same movie appears as a recommendation even though you already watched it.

## The Goal
As soon as you mark something as watched, it should disappear from the current recommendations on the page.

We also want this to happen automatically when you do "Recompute" or refresh the pool.

## What You Need to Do (Step by Step)

### Step 1: Make sure you have a fast way to check "is this watched?"
You probably already have a list of watched movies saved in the browser (localStorage).

Add this near the top of your JavaScript (after you load the watched library):

```js
// Fast lookup set so we can quickly answer "have I watched this?"
let watchedIds = new Set();

function rebuildWatchedIds() {
  watchedIds.clear();
  // yourLibrary = whatever variable holds your watched movies
  yourLibrary.forEach(function(item) {
    const key = item.id + ':' + (item.mediaType || 'movie');
    watchedIds.add(key);
  });
}

// Call this once when the page loads, and every time the library changes
rebuildWatchedIds();
```

### Step 2: Add the removal function
Paste this function somewhere in your JavaScript (it can go near your other helper functions).

```js
function removeFromCurrentDiscover(id, mediaType) {
  mediaType = mediaType || 'movie';
  const key = id + ':' + mediaType;

  // 1. If you keep a "pool" (the raw list of candidates), remove the watched one from it
  if (window.currentPool && Array.isArray(window.currentPool)) {
    window.currentPool = window.currentPool.filter(function(item) {
      const itemKey = item.id + ':' + (item.mediaType || 'movie');
      return itemKey !== key;
    });
  }

  // 2. If you keep a list of the currently displayed recommendations, remove it from there too
  if (window.currentRecommendations && Array.isArray(window.currentRecommendations)) {
    window.currentRecommendations = window.currentRecommendations.filter(function(item) {
      const itemKey = item.id + ':' + (item.mediaType || 'movie');
      return itemKey !== key;
    });
  }

  // 3. Re-draw the recommendation section without the watched movie
  // Change the function name below to whatever you actually use to draw the cards.
  if (typeof window.renderRecommended === 'function') {
    if (window.currentRecommendations) {
      window.renderRecommended(window.currentRecommendations);
    } else if (window.currentPool) {
      window.renderRecommended(window.currentPool);
    }
  } else if (typeof window.recomputeRecommendations === 'function') {
    // Fallback: force a full Recompute (the pool should already be cleaned)
    window.recomputeRecommendations();
  }
}
```

### Step 3: Call the removal function when the user marks something as watched
Find the place in your code where you add a movie to "Your Library" or mark it as watched.

It probably looks something like:

```js
function markAsWatched(item) {
  // ... your existing code that adds the item to the library ...
  yourLibrary.push(item);
  saveLibrary();

  // NEW LINE - add this right after you save the library
  removeFromCurrentDiscover(item.id, item.mediaType || 'movie');

  // update the "Watched" count on the screen if you have one
  updateWatchedCount();
}
```

### Step 4: Also clean the pool when you Recompute
Find your "Recompute" or "Refresh Pool" function.

At the very beginning, after you get the raw pool from the Worker/TMDB, add this filter:

```js
// inside your Recompute function, right after you have the pool
let pool = ...; // the list you just fetched or built

// NEW: throw out anything the user has already watched
pool = pool.filter(function(item) {
  const key = item.id + ':' + (item.mediaType || 'movie');
  return !watchedIds.has(key);
});

// then continue with your normal subgenre filtering, etc.
```

### Step 5: Make sure watchedIds is rebuilt whenever the library changes
Whenever you add or remove something from the watched library, call:

```js
rebuildWatchedIds();
```

This keeps the fast lookup in sync.

## Testing
1. Mark a movie as watched from the recommendations.
2. It should immediately disappear from the list.
3. Hit Recompute — it should not come back (because we also filter the pool).

## If you are still seeing duplicates after these changes
- Make sure you called `rebuildWatchedIds()` after changing the library.
- Make sure the removal function is being called in the exact place where you add to the library.
- Hard refresh the page (Ctrl+Shift+R) after deploying.

This pattern works for both the current "Recommended for you" list and for search results if you want to apply the same filter there.
