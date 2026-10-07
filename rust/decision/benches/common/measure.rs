//! Measurements keep allocation instrumentation out of timing samples.
use serde_json::json;
use std::alloc::{GlobalAlloc, Layout, System};
use std::hint::black_box;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::Instant;

struct AllocationCounter;
static TRACKING: AtomicBool = AtomicBool::new(false);
static ALLOCATIONS: AtomicUsize = AtomicUsize::new(0);
static BYTES: AtomicUsize = AtomicUsize::new(0);

// SAFETY: Each method forwards the unchanged pointer and layout to System.
// This single-threaded executable only records allocation counts and sizes.
unsafe impl GlobalAlloc for AllocationCounter {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        if TRACKING.load(Ordering::Relaxed) {
            ALLOCATIONS.fetch_add(1, Ordering::Relaxed);
            BYTES.fetch_add(layout.size(), Ordering::Relaxed);
        }
        unsafe { System.alloc(layout) }
    }

    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        unsafe { System.dealloc(pointer, layout) }
    }

    unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        if TRACKING.load(Ordering::Relaxed) {
            ALLOCATIONS.fetch_add(1, Ordering::Relaxed);
            BYTES.fetch_add(size, Ordering::Relaxed);
        }
        unsafe { System.realloc(pointer, layout, size) }
    }
}

#[global_allocator]
static ALLOCATOR: AllocationCounter = AllocationCounter;

pub(super) fn measure<T>(name: &str, mut operation: impl FnMut() -> T) {
    measure_input(name, || (), |_| operation());
}

pub(super) fn measure_input<I, T>(
    name: &str,
    mut input: impl FnMut() -> I,
    mut operation: impl FnMut(I) -> T,
) {
    drop(black_box(operation(input())));
    let prepared = input();
    ALLOCATIONS.store(0, Ordering::Relaxed);
    BYTES.store(0, Ordering::Relaxed);
    TRACKING.store(true, Ordering::Relaxed);
    let result = black_box(operation(prepared));
    TRACKING.store(false, Ordering::Relaxed);
    let allocations = ALLOCATIONS.load(Ordering::Relaxed);
    let bytes = BYTES.load(Ordering::Relaxed);
    drop(result);
    let mut times = Vec::with_capacity(31);
    for _ in 0..31 {
        let prepared = input();
        let started = Instant::now();
        let result = black_box(operation(prepared));
        times.push(started.elapsed().as_nanos());
        drop(result);
    }
    times.sort_unstable();
    println!(
        "{}",
        json!({"operation":name,"allocations":allocations,
        "allocated_bytes":bytes,"samples":times.len(),"median_ns":times[15],
        "p95_ns":times[29],"min_ns":times[0]})
    );
}
