# Keeps for the rest of a build what Jekyll 3.10, the version of GitHub Pages, works out again on
# every page, and between builds the files it already copied. Without it the build time grew with
# the square of the pages.
# It is loaded through the Gemfile because the github-pages gem never loads the _plugins folder.

require "set"

# Jekyll 3.10 lists the files of the whole site again every time it checks a front matter default
# whose path has a "*", and it checks every default each time a page is read from Liquid, as the
# "**/index.es.*" default of _config.yml does. This keeps the matches of each pattern (as Jekyll 4
# does) and whether each path matched it.
module JekyllGlobCache
    def applies_path?(scope, path)
        return super unless scope["path"].to_s.include?("*")

        @glob_matches ||= {}
        key = [scope["path"], path]
        return @glob_matches[key] if @glob_matches.key?(key)

        # The test of path_is_subpath? against every match, as one lookup per folder of the path.
        scope_paths = cached_scope_paths(scope["path"])
        @glob_matches[key] = Pathname.new(sanitize_path(path)).ascend.any? { |ascended_path| scope_paths.include?(ascended_path.to_s) }
    end

    def clear_glob_cache
        @scope_paths = {}
        @glob_matches = {}
    end

    private

    # What the pattern matches, relative to the site as Jekyll compares it.
    def cached_scope_paths(pattern)
        @scope_paths ||= {}
        @scope_paths[pattern] ||= begin
            site_path = Pathname.new(@site.source)
            matches = Dir.glob(File.join(@site.source, Pathname.new(pattern)))
            matches.map { |match| strip_collections_dir(Pathname.new(match).relative_path_from(site_path)).to_s }.to_set
        end
    end
end

Jekyll::FrontmatterDefaults.prepend(JekyllGlobCache)

# Each rebuild of "jekyll serve" may see files added or removed since the last one.
Jekyll::Hooks.register :site, :after_reset do |site|
    site.frontmatter_defaults.clear_glob_cache
end

# Before rendering, so they include what the generators added:
# - site.page_urls: the url of every page, space separated, so a layout finds out whether a page
#   exists with a cheap "contains". Built in Liquid, it read every page again on every page.
# - site.folder_files: the static files directly inside each folder, by its path ending in "/",
#   sorted by path. Filtering site.static_files instead went through every file of the site for
#   each link.
Jekyll::Hooks.register :site, :pre_render do |site|
    site.config["page_urls"] = " " + site.pages.map(&:url).join(" ") + " "
    folders = site.static_files.group_by { |file| File.join(File.dirname(file.relative_path), "") }
    site.config["folder_files"] = folders.transform_values { |files| files.sort_by(&:relative_path) }
end

# Jekyll 3.10 remembers what it copied only while the process lives, so every new build copies
# every model, texture and image again. A copy keeps the modification time of its source: a file
# already in the destination with that time and the same size is left as it is.
module JekyllUnchangedCopy
    def write(dest)
        dest_path = destination(dest)
        if File.file?(dest_path) && File.mtime(dest_path).to_i == mtime && File.size(dest_path) == File.size(path)
            self.class.mtimes[path] = mtime
            return false
        end
        super
    end
end

Jekyll::StaticFile.prepend(JekyllUnchangedCopy)
