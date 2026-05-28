use crate::bindings::mithic::process::types::Process;

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum JobStatus {
    Running,
    Stopped,
    Done(u8),
}

pub struct Job {
    pub id: usize,
    pub pids: Vec<u32>,
    pub command: String,
    pub status: JobStatus,
    pub processes: Vec<Process>,
}

pub struct JobTable {
    jobs: Vec<Option<Job>>,
    current: Option<usize>,
}

impl JobTable {
    pub fn new() -> Self {
        JobTable { jobs: Vec::new(), current: None }
    }

    pub fn add(&mut self, processes: Vec<Process>, command: String) -> usize {
        let id = self.next_id();
        let pids: Vec<u32> = processes.iter().map(|p| p.pid()).collect();
        let job = Job {
            id,
            pids,
            command,
            status: JobStatus::Running,
            processes,
        };
        if id > self.jobs.len() {
            self.jobs.resize_with(id, || None);
        }
        self.jobs[id - 1] = Some(job);
        self.current = Some(id);
        id
    }

    pub fn get(&self, id: usize) -> Option<&Job> {
        if id == 0 || id > self.jobs.len() { return None; }
        self.jobs[id - 1].as_ref()
    }

    pub fn get_mut(&mut self, id: usize) -> Option<&mut Job> {
        if id == 0 || id > self.jobs.len() { return None; }
        self.jobs[id - 1].as_mut()
    }

    pub fn remove(&mut self, id: usize) -> Option<Job> {
        if id == 0 || id > self.jobs.len() { return None; }
        let job = self.jobs[id - 1].take();
        if self.current == Some(id) {
            self.current = self.jobs.iter().rposition(|s| s.is_some()).map(|i| i + 1);
        }
        job
    }

    pub fn current_id(&self) -> Option<usize> {
        self.current
    }

    pub fn iter(&self) -> impl Iterator<Item = &Job> {
        self.jobs.iter().filter_map(|slot| slot.as_ref())
    }

    pub fn iter_mut(&mut self) -> impl Iterator<Item = &mut Job> {
        self.jobs.iter_mut().filter_map(|slot| slot.as_mut())
    }

    pub fn is_empty(&self) -> bool {
        self.jobs.iter().all(|s| s.is_none())
    }

    fn next_id(&self) -> usize {
        for (i, slot) in self.jobs.iter().enumerate() {
            if slot.is_none() { return i + 1; }
        }
        self.jobs.len() + 1
    }
}

impl std::fmt::Display for JobStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            JobStatus::Running => write!(f, "Running"),
            JobStatus::Stopped => write!(f, "Stopped"),
            JobStatus::Done(code) => write!(f, "Done({})", code),
        }
    }
}
