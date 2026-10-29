export namespace main {
	
	export class AssetData {
	    path: string;
	    mime: string;
	    data: string;
	    size: number;
	
	    static createFrom(source: any = {}) {
	        return new AssetData(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.path = source["path"];
	        this.mime = source["mime"];
	        this.data = source["data"];
	        this.size = source["size"];
	    }
	}
	export class FileContent {
	    path?: string;
	    content: string;
	    encoding: string;
	    line_ending: string;
	    mixed_line_ending: boolean;
	
	    static createFrom(source: any = {}) {
	        return new FileContent(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.path = source["path"];
	        this.content = source["content"];
	        this.encoding = source["encoding"];
	        this.line_ending = source["line_ending"];
	        this.mixed_line_ending = source["mixed_line_ending"];
	    }
	}
	export class FileStamp {
	    exists: boolean;
	    size: number;
	    mod_time: number;
	
	    static createFrom(source: any = {}) {
	        return new FileStamp(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.exists = source["exists"];
	        this.size = source["size"];
	        this.mod_time = source["mod_time"];
	    }
	}
	export class RecoveryEntry {
	    id: string;
	    path: string;
	    content: string;
	    encoding: string;
	    line_ending: string;
	    updated_at: number;
	    exists: boolean;
	
	    static createFrom(source: any = {}) {
	        return new RecoveryEntry(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.path = source["path"];
	        this.content = source["content"];
	        this.encoding = source["encoding"];
	        this.line_ending = source["line_ending"];
	        this.updated_at = source["updated_at"];
	        this.exists = source["exists"];
	    }
	}

}

